import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  isolatedProcessOptions,
  signalProcessTree,
} from "../../server/process-tree.mjs";
import {
  createLauncherRestartClient,
  createLauncherRestartSupervisor,
  HOST_RESTART_EXIT_CODE,
} from "../../server/launcher-restart.mjs";

function fixture(options = {}) {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  const state = { stopping: false, committed: false, dropReply: false };
  parent.connected = child.connected = true;
  child.send = (message, callback) => {
    queueMicrotask(() => {
      parent.emit("message", message);
      callback?.(null);
    });
    return true;
  };
  parent.send = (message, callback) => {
    queueMicrotask(() => {
      if (!state.dropReply) child.emit("message", message);
      callback?.(null);
    });
    return true;
  };
  const supervisor = createLauncherRestartSupervisor(parent, {
    enabled: options.enabled ?? true,
    isStopping: () => state.stopping,
    assertOwned: options.assertOwned ?? (async () => {}),
  });
  const client = createLauncherRestartClient(child, options.timeoutMs ?? 500);
  return {
    parent,
    child,
    state,
    supervisor,
    client,
    commit: () => {
      state.committed = true;
      return true;
    },
    close: () => supervisor.close(),
  };
}

test("only accepted handoff plus a clean restart exit authorizes replacement", async (t) => {
  const f = fixture();
  t.after(f.close);
  assert.equal(await f.client.inspect(), true);
  assert.equal(f.supervisor.shouldRestart(HOST_RESTART_EXIT_CODE, null), false);
  assert.deepEqual(await f.client.request(f.commit), { code: 0, issued: true });
  assert.equal(f.state.committed, true);
  assert.equal(f.supervisor.shouldRestart(HOST_RESTART_EXIT_CODE, null), true);
  for (const [code, signal] of [
    [0, null],
    [1, null],
    [null, "SIGTERM"],
  ])
    assert.equal(f.supervisor.shouldRestart(code, signal), false);
  // Another identity cannot overwrite the accepted intent.
  assert.deepEqual(await f.client.request(f.commit), {
    code: 1,
    issued: false,
  });
  f.state.stopping = true;
  assert.equal(f.supervisor.shouldRestart(HOST_RESTART_EXIT_CODE, null), false);
});

test("unsupported, disconnected, and ownerless channels never acquire restart authority", async (t) => {
  const f = fixture({ enabled: false });
  t.after(f.close);
  assert.equal(await f.client.inspect(), false);
  assert.deepEqual(await f.client.request(f.commit), {
    code: 1,
    issued: false,
  });
  assert.equal(f.state.committed, false);
  f.child.connected = false;
  assert.equal(await f.client.inspect(), false);
  const ownerless = new EventEmitter();
  ownerless.connected = true;
  ownerless.send = (_message, callback) => {
    callback?.(null);
    return true;
  };
  assert.equal(
    await createLauncherRestartClient(ownerless, 20).inspect(),
    false,
  );
  assert.equal(ownerless.listenerCount("message"), 0);
  assert.equal(ownerless.listenerCount("disconnect"), 0);
});

test("failed commit does not send a restart request", async (t) => {
  const f = fixture();
  t.after(f.close);
  assert.deepEqual(await f.client.request(() => false), {
    code: 1,
    issued: false,
  });
  assert.equal(f.supervisor.shouldRestart(HOST_RESTART_EXIT_CODE, null), false);
});

test("ownership is checked after commit and failed ownership proves non-issuance", async (t) => {
  let f;
  f = fixture({
    assertOwned: async () => {
      assert.equal(f.state.committed, true);
      throw new Error("lease lost");
    },
  });
  t.after(f.close);
  assert.deepEqual(await f.client.request(f.commit), {
    code: 1,
    issued: false,
  });
  assert.equal(f.supervisor.shouldRestart(HOST_RESTART_EXIT_CODE, null), false);
});

test("a stop racing the asynchronous ownership check wins", async (t) => {
  let release;
  let entered;
  const checking = new Promise((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    assertOwned: () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  t.after(f.close);
  const result = f.client.request(f.commit);
  await checking;
  f.state.stopping = true;
  release();
  assert.deepEqual(await result, { code: 1, issued: false });
  assert.equal(f.supervisor.shouldRestart(HOST_RESTART_EXIT_CODE, null), false);
});

test("lost acceptance stays uncertain, retires listeners, and cannot turn a later stop into restart", async (t) => {
  let delayedReply;
  const f = fixture({ timeoutMs: 30 });
  t.after(f.close);
  const send = f.parent.send;
  f.parent.send = (message, callback) => {
    if (f.state.committed) {
      delayedReply = message;
      callback?.(null);
      return true;
    }
    return send(message, callback);
  };
  await assert.rejects(f.client.request(f.commit), /did not confirm/);
  assert.equal(f.state.committed, true);
  assert.equal(f.child.listenerCount("message"), 0);
  assert.equal(f.child.listenerCount("disconnect"), 0);
  f.child.emit("message", delayedReply);
  assert.equal(f.supervisor.shouldRestart(0, null), false);
});

test("channel loss after commit is uncertain and is never retried automatically", async (t) => {
  const f = fixture();
  t.after(f.close);
  let requests = 0;
  const send = f.child.send;
  f.child.send = (message, callback) => {
    if (message.action === "restart") {
      requests++;
      f.child.connected = false;
      queueMicrotask(() => f.child.emit("disconnect"));
      return true;
    }
    return send(message, callback);
  };
  await assert.rejects(f.client.request(f.commit), /disconnected/);
  assert.equal(requests, 1);
  assert.equal(f.child.listenerCount("message"), 0);
  assert.equal(f.supervisor.shouldRestart(HOST_RESTART_EXIT_CODE, null), false);
});

async function launcherFixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), "inspire-launcher-handoff-"));
  const build = join(root, "build", "server");
  await mkdir(build, { recursive: true });
  await mkdir(join(root, "dist"));
  await cp(resolve("inspire.mjs"), join(root, "inspire.mjs"));
  for (const file of [
    "file-lock",
    "instance-state",
    "instance-control",
    "launcher-restart",
    "npm-command",
    "platform-paths",
    "platform-environment",
    "process-tree",
    "static-asset-cache",
    "user-environment",
  ])
    await cp(resolve("server", `${file}.mjs`), join(build, `${file}.mjs`));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "dist", "index.html"), "");
  await writeFile(join(build, "terminal-daemon-entry.js"), "");
  await writeFile(
    join(build, "index.js"),
    `
    import { appendFile, readFile, writeFile } from "node:fs/promises";
    import { createLauncherRestartClient, HOST_RESTART_EXIT_CODE } from "./launcher-restart.mjs";
    await appendFile(process.env.TEST_LAUNCHES, "started\\n");
    const result = await createLauncherRestartClient().request(() => true);
    if (!result.issued) process.exit(2);
    await writeFile(process.env.TEST_READY, "ready");
    if (process.env.TEST_MODE === "failed-cleanup") process.exit(1);
    // Model the real shutdown interval after state removal but before exit.
    while (!(await readFile(process.env.INSPIRE_STOP_REQUEST_PATH).catch(() => null)))
      await new Promise(resolve => setTimeout(resolve, 10));
    process.exit(HOST_RESTART_EXIT_CODE);
  `,
  );
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_RUNTIME_DIR: join(root, "runtime"),
    INSPIRE_HOST: "127.0.0.1",
    INSPIRE_PORT: String(port),
    INSPIRE_STATE_PATH: join(root, "instance.json"),
    INSPIRE_OPEN: "0",
    INSPIRE_ENVIRONMENT: "inherit",
    TEST_LAUNCHES: join(root, "launches"),
    TEST_READY: join(root, "ready"),
    TEST_MODE: mode,
  };
  delete env.SYSTEMD_EXEC_PID;
  const child = spawn(process.execPath, [join(root, "inspire.mjs")], {
    cwd: root,
    env,
    ...isolatedProcessOptions(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await signalProcessTree(child, "SIGKILL", { isolated: true });
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, env, child, exited, output: () => output };
}

test("launcher does not replace a Host whose restart cleanup failed", {
  timeout: 60_000,
}, async (t) => {
  const f = await launcherFixture(t, "failed-cleanup");
  assert.equal(await f.exited, 1, f.output());
  assert.equal(await readFile(f.env.TEST_LAUNCHES, "utf8"), "started\n");
});

test("standalone stop cancels page replacement even after Host state disappeared", {
  timeout: 60_000,
}, async (t) => {
  const f = await launcherFixture(t, "stop-race");
  const deadline = Date.now() + 30_000;
  while (!(await readFile(f.env.TEST_READY).catch(() => null))) {
    assert.equal(f.child.exitCode, null, f.output());
    assert.ok(Date.now() < deadline, f.output());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const result = await promisify(execFileCallback)(
    process.execPath,
    [join(f.root, "inspire.mjs"), "stop"],
    { env: f.env, timeout: 30_000 },
  );
  assert.match(
    result.stdout,
    /Cancelled the pending INSΠRE startup|No managed INSΠRE instance/u,
  );
  assert.equal(await f.exited, 0, f.output());
  assert.equal(await readFile(f.env.TEST_LAUNCHES, "utf8"), "started\n");
});
