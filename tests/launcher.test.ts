import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isolatedProcessOptions,
  signalProcessTree,
} from "../server/process-tree.mjs";
import { TerminalDaemonClient } from "../server/terminal-daemon-client.js";
import { terminalDaemonSecretPath } from "../server/terminal-daemon-tls.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "inspire.mjs");
const children: ChildProcess[] = [];
const temporaryDirectories: string[] = [];
const terminalChildren: ChildProcess[] = [];
let activeEnvironment: NodeJS.ProcessEnv | null = null;
/** The launcher that owns the active environment's instance. */
let activeLauncher = launcher;

/** A disposable copy of the working tree with shared dependencies, for a
 * test whose launcher builds into its own directory. */
async function isolatedCheckout(directory: string): Promise<string> {
  const checkout = join(directory, "checkout");
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    await mkdir(dirname(join(checkout, file)), { recursive: true });
    // A tracked file deleted in the working tree is absent from the copy.
    await copyFile(join(root, file), join(checkout, file)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
  await symlink(
    join(root, "node_modules"),
    join(checkout, "node_modules"),
    "junction",
  );
  return checkout;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a TCP test server");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

function launcherEnv(
  statePath: string,
  port: number,
  home: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "runtime"),
    INSPIRE_HOST: "127.0.0.1",
    INSPIRE_PORT: String(port),
    INSPIRE_STATE_PATH: statePath,
    INSPIRE_OPEN: "0",
  };
}

function runLauncher(
  args: string[],
  env: NodeJS.ProcessEnv,
  path = launcher,
): string {
  return execFileSync(process.execPath, [path, ...args], {
    cwd: dirname(path),
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

async function waitForLauncher(
  child: ChildProcess,
  env: NodeJS.ProcessEnv,
  output: Buffer[],
  timeout = 60_000,
  path = launcher,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastStatus = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Isolated launcher exited before ready (code=${child.exitCode}, signal=${child.signalCode})\n${Buffer.concat(output)}`,
      );
    try {
      // Do not repeatedly spawn Node while a cold build has not published a Host.
      await access(env.INSPIRE_STATE_PATH!);
      lastStatus = runLauncher(["status"], env, path);
      if (lastStatus.startsWith("INSΠRE is running.")) return;
    } catch (error) {
      lastStatus = String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `Timed out waiting for isolated launcher acceptance\n${lastStatus}\n${Buffer.concat(output)}`,
  );
}

afterEach(async () => {
  if (activeEnvironment) {
    try {
      runLauncher(["stop"], activeEnvironment, activeLauncher);
    } catch {
      // The child may already have exited; cleanup below still removes only
      // this test's temporary directory.
    }
    activeEnvironment = null;
  }
  activeLauncher = launcher;
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  for (const child of terminalChildren.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const stopped = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    await signalProcessTree(child, "SIGTERM", { isolated: true });
    await stopped;
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("production launcher", () => {
  it("stops the readiness wait when the service process exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-systemd-ready-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "instance.json");
    const port = await freePort();
    const environment = {
      ...launcherEnv(statePath, port, join(directory, "home")),
      MAINPID: "999999999",
    };

    expect(() => runLauncher(["wait-ready"], environment)).toThrow(
      /Host process exited before becoming ready/u,
    );
  });

  it.runIf(process.platform !== "linux")(
    "keeps Linux system-service commands explicit on other systems",
    () => {
      const environment = { ...process.env, INSPIRE_OPEN: "0" };
      expect(() =>
        runLauncher(["service", "status-host"], environment),
      ).toThrow(/require Linux systemd/u);
    },
  );

  it("restarts without an existing instance and owns one isolated lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-launcher-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "instance.json");
    const port = await freePort();
    const home = join(directory, "home");
    const env = launcherEnv(statePath, port, home);
    // The launcher builds into its own checkout; never the shared one, whose
    // dist/ a running Host may serve.
    const checkout = await isolatedCheckout(directory);
    const checkoutLauncher = join(checkout, "inspire.mjs");
    activeLauncher = checkoutLauncher;
    // A user-exported NODE_ENV must not select an in-process terminal owner.
    env.NODE_ENV = "test";
    env.INSPIRE_TERMINAL_DAEMON_ADDRESS =
      process.platform === "win32"
        ? `\\\\.\\pipe\\inspire-terminal-launcher-${port}`
        : join(directory, "terminal.sock");
    env.INSPIRE_TERMINAL_TOKEN_PATH = join(directory, "terminal-token");
    env.INSPIRE_TERMINAL_STATE_PATH = join(directory, "terminals.json");
    const terminalChild = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(checkout, "server", "terminal-daemon-entry.ts"),
        "--root",
        checkout,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--address",
        env.INSPIRE_TERMINAL_DAEMON_ADDRESS,
        "--token-path",
        env.INSPIRE_TERMINAL_TOKEN_PATH,
        "--state-path",
        env.INSPIRE_TERMINAL_STATE_PATH,
      ],
      { cwd: checkout, env, ...isolatedProcessOptions(), stdio: "ignore" },
    );
    terminalChildren.push(terminalChild);
    await vi.waitFor(
      async () => {
        const token = (
          await readFile(
            terminalDaemonSecretPath(env.INSPIRE_TERMINAL_TOKEN_PATH!),
            "utf8",
          )
        ).trim();
        await new TerminalDaemonClient(
          env.INSPIRE_TERMINAL_DAEMON_ADDRESS!,
          token,
        ).probe();
      },
      { timeout: 8_000 },
    );
    expect(runLauncher(["stop"], env, checkoutLauncher)).toContain(
      "No managed INSΠRE instance is running.",
    );
    // Cold startup must archive an outgoing chunk still used by an open page.
    const outgoingAsset = "ContextPane-launcher-old.js";
    const publishedAsset = join(checkout, "dist", "assets", outgoingAsset);
    await mkdir(dirname(publishedAsset), { recursive: true });
    await writeFile(publishedAsset, "old chunk\n");
    const output: Buffer[] = [];
    const child = spawn(process.execPath, [checkoutLauncher, "restart"], {
      cwd: checkout,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeEnvironment = env;
    children.push(child);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));

    await waitForLauncher(child, env, output, 120_000, checkoutLauncher);
    const readState = async () =>
      JSON.parse(await readFile(statePath, "utf8")) as {
        pid: number;
        token: string;
      };
    const firstState = await readState();
    runLauncher(["wait-ready"], env, checkoutLauncher);
    // Remove the publication handoff copy to exercise the Host's retained generation.
    await rm(publishedAsset);
    const origin = `http://127.0.0.1:${port}`;
    const retainedAssetResponse = await fetch(
      `${origin}/assets/${outgoingAsset}`,
    );
    expect(retainedAssetResponse.status).toBe(200);
    expect(await retainedAssetResponse.text()).toBe("old chunk\n");
    const terminalHeaders = {
      Authorization: `Bearer ${firstState.token}`,
      "Content-Type": "application/json",
    };
    const epochResponse = await fetch(`${origin}/api/terminal-operations`, {
      headers: terminalHeaders,
    });
    const { epoch } = (await epochResponse.json()) as { epoch: string };
    const mutationHeaders = () => ({
      ...terminalHeaders,
      "X-Terminal-Operation": JSON.stringify({ id: randomUUID(), epoch }),
    });
    const createdTerminalResponse = await fetch(`${origin}/api/terminals`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ cwd: directory, cols: 80, rows: 24 }),
    });
    expect(createdTerminalResponse.ok).toBe(true);
    const createdTerminal = (await createdTerminalResponse.json()) as {
      id: string;
    };

    const restartStatus = () =>
      fetch(`${origin}/api/host/restart`, {
        headers: terminalHeaders,
      }).then((response) => response.json());
    const terminals = () =>
      fetch(`${origin}/api/terminals?cwd=${encodeURIComponent(directory)}`, {
        headers: terminalHeaders,
      }).then((response) => response.json());
    const assertTerminalPreserved = async () =>
      expect((await terminals()).terminals).toContainEqual(
        expect.objectContaining({ id: createdTerminal.id, status: "running" }),
      );

    const original = await restartStatus();
    expect(original).toMatchObject({ available: true, allAvailable: false });
    const response = await fetch(`${origin}/api/host/restart`, {
      method: "POST",
      headers: terminalHeaders,
      body: JSON.stringify({
        hostId: original.hostId,
        operationId: randomUUID(),
        scope: "host",
      }),
    });
    expect(response.status).toBe(202);
    await vi.waitFor(
      async () => {
        const status = await restartStatus();
        expect(status.available).toBe(true);
        expect(status.hostId).not.toBe(original.hostId);
        const state = await readState();
        expect(state.token).toBe(firstState.token);
        expect(state.pid).not.toBe(firstState.pid);
      },
      { timeout: 60_000, interval: 100 },
    );
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    await assertTerminalPreserved();

    const stopOutput = runLauncher(["stop"], env, checkoutLauncher);
    expect(stopOutput).toContain("Stopped INSΠRE process");
    const exitCode = await new Promise<number | null>((resolveExit) =>
      child.once("close", (code) => resolveExit(code)),
    );
    expect(exitCode).toBe(0);
    activeEnvironment = null;
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const restarted = spawn(process.execPath, [checkoutLauncher, "start"], {
      cwd: checkout,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeEnvironment = env;
    children.push(restarted);
    const restartOutput: Buffer[] = [];
    restarted.stdout!.on("data", (chunk: Buffer) => restartOutput.push(chunk));
    restarted.stderr!.on("data", (chunk: Buffer) => restartOutput.push(chunk));
    await waitForLauncher(
      restarted,
      env,
      restartOutput,
      undefined,
      checkoutLauncher,
    );
    expect((await readState()).token).toBe(firstState.token);
    await assertTerminalPreserved();
    const closeTerminalResponse = await fetch(
      `${origin}/api/terminals/${encodeURIComponent(createdTerminal.id)}?force=1`,
      { method: "DELETE", headers: mutationHeaders() },
    );
    expect(closeTerminalResponse.ok).toBe(true);
    expect(runLauncher(["stop"], env, checkoutLauncher)).toContain(
      "Stopped INSΠRE process",
    );
    const restartedExit =
      restarted.exitCode ??
      (await new Promise<number | null>((resolveExit) =>
        restarted.once("close", resolveExit),
      ));
    expect(restartedExit).toBe(0);
    activeEnvironment = null;
  }, 240_000);
});
