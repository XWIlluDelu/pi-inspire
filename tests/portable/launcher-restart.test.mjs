import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  createLauncherRestartClient,
  createLauncherRestartSupervisor,
  HOST_RESTART_EXIT_CODE,
} from "../../server/launcher-restart.mjs";
import {
  isolatedProcessOptions,
  signalProcessTree,
} from "../../server/process-tree.mjs";
import {
  directLauncherEnvironment,
  preparePackagedLauncher,
} from "../fixtures/packaged-launcher.mjs";

const refused = { code: 1, issued: false };

function fixture(t, options = {}) {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  const state = { stopping: false, committed: false };
  parent.connected = child.connected = true;
  const deliver = (peer) => (message, callback) => {
    queueMicrotask(() => {
      peer.emit("message", message);
      callback?.(null);
    });
    return true;
  };
  child.send = deliver(parent);
  parent.send = deliver(child);
  const supervisor = createLauncherRestartSupervisor(parent, {
    enabled: options.enabled ?? true,
    isStopping: () => state.stopping,
    assertOwned: options.assertOwned ?? (async () => {}),
  });
  const client = createLauncherRestartClient(child, options.timeoutMs ?? 500);
  t.after(supervisor.close);
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
  };
}

test("only accepted handoff plus a clean restart exit authorizes replacement", async (t) => {
  const f = fixture(t);
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
  assert.deepEqual(await f.client.request(f.commit), refused);
  f.state.stopping = true;
  assert.equal(f.supervisor.shouldRestart(HOST_RESTART_EXIT_CODE, null), false);
});

test("unsupported, disconnected, and ownerless channels never acquire restart authority", async (t) => {
  const f = fixture(t, { enabled: false });
  assert.equal(await f.client.inspect(), false);
  assert.deepEqual(await f.client.request(f.commit), refused);
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

test("refuses dispatch after commit refusal, early disconnect, lease loss or a racing stop", async (t) => {
  for (const failure of ["commit", "disconnect", "lease", "stop"]) {
    await t.test(failure, async (t) => {
      const checking = Promise.withResolvers();
      const release = Promise.withResolvers();
      const f = fixture(t, {
        assertOwned: async () => {
          assert.equal(f.state.committed, true);
          if (failure === "lease") throw new Error("lease lost");
          if (failure === "stop") {
            checking.resolve();
            await release.promise;
          }
        },
      });
      const result = f.client.request(() => {
        if (failure === "commit") return false;
        if (failure === "disconnect") f.child.connected = false;
        return f.commit();
      });
      if (failure === "stop") {
        await checking.promise;
        f.state.stopping = true;
        release.resolve();
      }
      assert.deepEqual(await result, refused);
      assert.equal(
        f.supervisor.shouldRestart(HOST_RESTART_EXIT_CODE, null),
        false,
      );
    });
  }
});

test("lost post-commit confirmation remains uncertain without retrying", async (t) => {
  for (const mode of ["reply", "disconnect"]) {
    await t.test(mode, async (t) => {
      const f = fixture(t, { timeoutMs: 50 });
      let delayedReply;
      let requests = 0;
      const send = f.child.send;
      f.child.send = (message, callback) => {
        if (message.action === "restart") {
          requests++;
          if (mode === "disconnect") {
            f.child.connected = false;
            queueMicrotask(() => f.child.emit("disconnect"));
            return true;
          }
        }
        return send(message, callback);
      };
      const reply = f.parent.send;
      f.parent.send = (message, callback) => {
        if (!f.state.committed) return reply(message, callback);
        delayedReply = message;
        callback?.(null);
        return true;
      };
      await assert.rejects(
        f.client.request(f.commit),
        mode === "reply" ? /did not confirm/ : /disconnected/,
      );
      assert.equal(f.state.committed, true);
      assert.equal(requests, 1);
      for (const event of ["message", "disconnect"])
        assert.equal(f.child.listenerCount(event), 0);
      if (delayedReply) f.child.emit("message", delayedReply);
      assert.equal(f.supervisor.shouldRestart(0, null), false);
      if (mode === "disconnect")
        assert.equal(
          f.supervisor.shouldRestart(HOST_RESTART_EXIT_CODE, null),
          false,
        );
    });
  }
});

test("standalone stop cancels page replacement even after Host state disappeared", {
  timeout: 60_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "inspire-launcher-handoff-"));
  await preparePackagedLauncher(root, {
    host: `
    import { appendFile, readFile, writeFile } from "node:fs/promises";
    import { createLauncherRestartClient, HOST_RESTART_EXIT_CODE } from "./launcher-restart.mjs";
    await appendFile(process.env.TEST_LAUNCHES, "started\\n");
    const result = await createLauncherRestartClient().request(() => true);
    if (!result.issued) process.exit(2);
    await writeFile(process.env.TEST_READY, "ready");
    // Model the real shutdown interval after state removal but before exit.
    while (!(await readFile(process.env.INSPIRE_STOP_REQUEST_PATH).catch(() => null)))
      await new Promise(resolve => setTimeout(resolve, 10));
    process.exit(HOST_RESTART_EXIT_CODE);
  `,
  });
  const env = {
    ...(await directLauncherEnvironment(root)),
    TEST_LAUNCHES: join(root, "launches"),
    TEST_READY: join(root, "ready"),
  };
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
  const deadline = Date.now() + 30_000;
  while (!(await readFile(env.TEST_READY).catch(() => null))) {
    assert.equal(child.exitCode, null, output);
    assert.ok(Date.now() < deadline, output);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const result = await promisify(execFileCallback)(
    process.execPath,
    [join(root, "inspire.mjs"), "stop"],
    { env, timeout: 30_000 },
  );
  assert.match(
    result.stdout,
    /Cancelled the pending INSΠRE startup|No managed INSΠRE instance/u,
  );
  assert.equal(await exited, 0, output);
  assert.equal(await readFile(env.TEST_LAUNCHES, "utf8"), "started\n");
});
