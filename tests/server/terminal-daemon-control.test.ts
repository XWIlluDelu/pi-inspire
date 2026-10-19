import {
  type ChildProcess,
  execFile as execFileCallback,
  spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { processStartIdentity } from "../../server/instance-state.mjs";
import { signalProcessTree } from "../../server/process-tree.mjs";
import { TerminalDaemonClient } from "../../server/terminal-daemon-client.js";
import {
  controlTerminalDaemon,
  inspectTerminalDaemon,
} from "../../server/terminal-daemon-control.js";
import { defaultTerminalDaemonAddress } from "../../server/terminal-daemon-protocol.js";
import { readTerminalDaemonSecret } from "../../server/terminal-daemon-tls.js";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

const execFile = promisify(execFileCallback);
const root = resolve(".");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inspire-terminal-control-"));
  const environment = isolatedTestEnvironment(directory, {
    INSPIRE_ENVIRONMENT: "inherit",
    INSPIRE_OPEN: "0",
    INSPIRE_QUIET: "1",
    INSPIRE_PORT: String(20_000 + Math.floor(Math.random() * 30_000)),
    INSPIRE_TERMINAL_STATE_PATH: join(directory, "state.json"),
    INSPIRE_TERMINAL_TOKEN_PATH: join(directory, "token"),
    INSPIRE_TEST_CHILD_PID_FILE: join(directory, "owned-command.pid"),
    INSPIRE_TERMINAL_DAEMON_ADDRESS:
      process.platform === "win32"
        ? "\\\\.\\pipe\\inspire-control-" + randomUUID()
        : join(directory, "daemon.sock"),
    XDG_RUNTIME_DIR: join(directory, "runtime"),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=" + join(directory, "no-session-bus"),
  });
  // Exercise byte-bounded addresses even with Darwin's long temporary roots.
  environment.INSPIRE_TERMINAL_DAEMON_ADDRESS = defaultTerminalDaemonAddress(
    directory,
    "127.0.0.1",
    Number(environment.INSPIRE_PORT),
    { environment },
  );
  const options = {
    root,
    host: "127.0.0.1",
    port: Number(environment.INSPIRE_PORT),
    environment,
  };
  const children: ChildProcess[] = [];
  const cleanup = async () => {
    await controlTerminalDaemon("stop", options, true).catch(() => {});
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        await signalProcessTree(child, "SIGKILL", { isolated: false }).catch(
          () => {},
        );
    await rm(directory, { recursive: true, force: true });
  };
  const cli = (...args: string[]) =>
    execFile(
      process.execPath,
      [join(root, "inspire.mjs"), "terminal", ...args],
      { env: environment, timeout: 35_000 },
    );
  const start = async () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(root, "server/terminal-daemon-entry.ts"),
        "--root",
        root,
      ],
      { cwd: root, env: environment, stdio: "pipe", windowsHide: true },
    );
    children.push(child);
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    await vi.waitFor(
      async () => {
        if (child.exitCode !== null) throw Error(output);
        expect(await inspectTerminalDaemon(options), output).toMatchObject({
          kind: "running",
        });
      },
      { timeout: 30_000, interval: 150 },
    );
    const client = new TerminalDaemonClient(
      environment.INSPIRE_TERMINAL_DAEMON_ADDRESS!,
      await readTerminalDaemonSecret(environment.INSPIRE_TERMINAL_TOKEN_PATH!),
    );
    return { child, client };
  };
  return { directory, environment, options, start, cli, cleanup };
}

it("status is observational and invalid commands never create an authority", async () => {
  const f = await fixture();
  try {
    expect((await f.cli("status")).stdout).toContain(
      "No terminal daemon endpoint",
    );
    await expect(
      readFile(f.environment.INSPIRE_TERMINAL_TOKEN_PATH! + ".tls-v3"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      controlTerminalDaemon(
        "restart",
        {
          ...f.options,
          environment: {
            ...f.environment,
            INSPIRE_TERMINAL_ID: "managed-shell",
          },
        },
        true,
      ),
    ).rejects.toThrow("external OS terminal");
    await expect(f.cli("stop", "--unexpected")).rejects.toMatchObject({
      code: 64,
    });
  } finally {
    await f.cleanup();
  }
}, 45_000);

it("restarts only the authenticated scoped owner, stops actual PTYs, and restores tabs without execution", async () => {
  const f = await fixture();
  const other = await fixture();
  let clients: TerminalDaemonClient[] = [];
  try {
    await mkdir(join(f.directory, "project with spaces"));
    const first = await f.start();
    const independent = await other.start();
    clients = [first.client, independent.client];
    const before = await first.client.daemonInfo();
    const otherBefore = await independent.client.daemonInfo();
    const wrongScope = {
      ...f.options,
      environment: {
        ...f.environment,
        INSPIRE_TERMINAL_DAEMON_ADDRESS:
          other.environment.INSPIRE_TERMINAL_DAEMON_ADDRESS,
        INSPIRE_TERMINAL_TOKEN_PATH:
          other.environment.INSPIRE_TERMINAL_TOKEN_PATH,
      },
    };
    await expect(
      controlTerminalDaemon("stop", wrongScope, true),
    ).rejects.toThrow("different instance");
    expect((await independent.client.daemonInfo()).instanceId).toBe(
      otherBefore.instanceId,
    );
    const terminal = await first.client.create({
      cwd: join(f.directory, "project with spaces"),
      profileId: process.platform === "win32" ? "cmd" : "sh",
    });
    const attachment = await first.client.attach(
      {
        terminalId: terminal.id,
        clientId: randomUUID(),
        cols: 80,
        rows: 24,
      },
      { sendData() {}, sendControl() {}, close() {} },
    );
    const command =
      "require('fs').writeFileSync(process.env.INSPIRE_TEST_CHILD_PID_FILE,String(process.pid));setInterval(()=>{},1000)";
    const executable =
      process.platform === "win32"
        ? JSON.stringify(process.execPath)
        : "'" + process.execPath.replaceAll("'", "'\\''") + "'";
    attachment.writeInput(
      1,
      Buffer.from(executable + ' -e "' + command + '"\r'),
    );
    let ownedPid = 0;
    await vi.waitFor(
      async () => {
        ownedPid = Number(
          await readFile(f.environment.INSPIRE_TEST_CHILD_PID_FILE!, "utf8"),
        );
        expect(ownedPid).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    const ownedBirth = await processStartIdentity(ownedPid);
    await first.client.rename(terminal.id, { title: "Retained metadata" });
    // A live shell needs consent; refusal keeps both daemon and tab alive.
    await expect(f.cli("restart")).rejects.toThrow("--force");
    expect((await first.client.list()).terminals[0]?.status).toBe("running");
    // A stale identity cannot stop even an otherwise authenticated endpoint.
    await expect(
      first.client.shutdownDaemon(randomUUID(), true),
    ).rejects.toMatchObject({ code: "terminal_owner_changed" });
    const result = await f.cli("restart", "--force");
    expect(result.stdout).toContain("commands were not rerun");
    await vi.waitFor(
      async () => {
        const birth = await processStartIdentity(ownedPid).catch(() => null);
        let zombie = false;
        if (process.platform === "linux" && birth === ownedBirth) {
          const raw = await readFile(`/proc/${ownedPid}/stat`, "utf8");
          zombie = raw.slice(raw.lastIndexOf(")") + 2).startsWith("Z ");
        }
        expect(birth !== ownedBirth || zombie).toBe(true);
      },
      { timeout: 5_000 },
    );
    attachment.detach();
    const after = await inspectTerminalDaemon(f.options);
    expect(after.kind).toBe("running");
    if (after.kind !== "running") throw Error("Missing replacement");
    expect(after.info.instanceId).not.toBe(before.instanceId);
    await vi.waitFor(
      async () => {
        expect(
          await processStartIdentity(before.pid).catch(() => null),
        ).not.toBe(before.processStartTime);
      },
      { timeout: 5_000 },
    );
    const replaced = new TerminalDaemonClient(
      f.environment.INSPIRE_TERMINAL_DAEMON_ADDRESS!,
      await readTerminalDaemonSecret(
        f.environment.INSPIRE_TERMINAL_TOKEN_PATH!,
      ),
    );
    clients.push(replaced);
    expect((await replaced.list()).terminals).toMatchObject([
      { id: terminal.id, title: "Retained metadata", status: "exited" },
    ]);
    expect((await independent.client.daemonInfo()).instanceId).toBe(
      otherBefore.instanceId,
    );
    expect((await other.cli("status")).stdout).toContain("running");
    expect((await f.cli("stop")).stdout).toContain("Host was not restarted");
    expect((await f.cli("status")).stdout).toContain(
      "No terminal daemon endpoint",
    );
  } finally {
    for (const client of clients) await client.close();
    await Promise.all([f.cleanup(), other.cleanup()]);
  }
}, 90_000);
