import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directLauncherEnvironment,
  preparePackagedLauncher,
} from "./fixtures/packaged-launcher.mjs";
import { isolatedTestEnvironment } from "./server/fixtures/isolated-environment.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "inspire.mjs");
const children: ChildProcess[] = [];
const temporaryDirectories: string[] = [];
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
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("production launcher", () => {
  it("starts terminal Pi in the caller's project and keeps the installation separate", async () => {
    const install = await mkdtemp(join(tmpdir(), "inspire-pi-launch-"));
    temporaryDirectories.push(install);
    await preparePackagedLauncher(install);
    const project = join(install, "my project");
    await mkdir(project);
    await writeFile(join(project, "local.jsonl"), "caller session");
    await writeFile(
      join(install, "build/server/attached-pi-entry.js"),
      `import { readFileSync } from "node:fs";
       console.log(readFileSync(process.argv[3], "utf8"), process.env.INSPIRE_INSTALLATION_ROOT);`,
    );
    expect(
      execFileSync(
        process.execPath,
        [join(install, "inspire.mjs"), "pi", "--session", "local.jsonl"],
        {
          cwd: project,
          encoding: "utf8",
          env: { ...process.env, INSPIRE_ENVIRONMENT: "inherit" },
        },
      ).trim(),
    ).toBe(`caller session ${await realpath(install)}`);
  });

  it("stops the readiness wait when the service process exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-systemd-ready-"));
    temporaryDirectories.push(directory);
    const environment = {
      ...(await directLauncherEnvironment(directory)),
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
    const env: NodeJS.ProcessEnv = {
      ...isolatedTestEnvironment(directory),
      ...(await directLauncherEnvironment(directory)),
      INSPIRE_PI_COMMAND: process.env.INSPIRE_PI_COMMAND,
    };
    const statePath = env.INSPIRE_STATE_PATH!;
    const port = env.INSPIRE_PORT!;
    // The launcher builds into its own checkout; never the shared one, whose
    // dist/ a running Host may serve.
    const checkout = await isolatedCheckout(directory);
    const checkoutLauncher = join(checkout, "inspire.mjs");
    activeLauncher = checkoutLauncher;
    env.INSPIRE_TERMINAL_STATE_PATH = join(directory, "terminals.json");
    expect(runLauncher(["stop"], env, checkoutLauncher)).toContain(
      "No managed INSΠRE instance is running.",
    );
    // Cold startup ignores leftover files outside the published manifest.
    const outgoingAsset = "ContextPane-launcher-old.js";
    const publishedAsset = join(checkout, "dist", "assets", outgoingAsset);
    await mkdir(dirname(publishedAsset), { recursive: true });
    await writeFile(publishedAsset, "old chunk\n");
    async function launch(mode: "restart" | "start") {
      const output: Buffer[] = [];
      const child = spawn(process.execPath, [checkoutLauncher, mode], {
        cwd: checkout,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeEnvironment = env;
      children.push(child);
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
      await waitForLauncher(
        child,
        env,
        output,
        mode === "restart" ? 120_000 : 60_000,
        checkoutLauncher,
      );
      return child;
    }

    async function stop(child: ChildProcess) {
      const exited = once(child, "close");
      expect(runLauncher(["stop"], env, checkoutLauncher)).toContain(
        "Stopped INSΠRE process",
      );
      await expect(exited).resolves.toEqual([0, null]);
      activeEnvironment = null;
    }

    const child = await launch("restart");
    const readState = async () =>
      JSON.parse(await readFile(statePath, "utf8")) as {
        pid: number;
        token: string;
      };
    const firstState = await readState();
    runLauncher(["wait-ready"], env, checkoutLauncher);
    const origin = `http://127.0.0.1:${port}`;
    expect((await fetch(`${origin}/assets/${outgoingAsset}`)).status).toBe(404);
    const terminalHeaders = {
      Authorization: `Bearer ${firstState.token}`,
      "Content-Type": "application/json",
    };
    const epochResponse = await fetch(`${origin}/api/terminal-operations`, {
      headers: terminalHeaders,
    });
    const { epoch } = (await epochResponse.json()) as { epoch: string };
    const terminalOperation = (intent: unknown) =>
      fetch(`${origin}/api/terminal-operations`, {
        method: "POST",
        headers: terminalHeaders,
        body: JSON.stringify({
          operationId: randomUUID(),
          executor: { kind: "terminal", epoch },
          intent,
        }),
      });
    const createdTerminalResponse = await terminalOperation({
      command: "create",
      params: { request: { cwd: directory, cols: 80, rows: 24 } },
    });
    expect(createdTerminalResponse.ok).toBe(true);
    const { result: createdTerminal } =
      (await createdTerminalResponse.json()) as { result: { id: string } };

    const restartStatus = () =>
      fetch(`${origin}/api/host/restart`, {
        headers: terminalHeaders,
      }).then((response) => response.json());
    const terminals = () =>
      fetch(`${origin}/api/terminals?cwd=${encodeURIComponent(directory)}`, {
        headers: terminalHeaders,
      }).then((response) => response.json());

    const original = await restartStatus();
    expect(original).toMatchObject({ available: true });
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
    expect((await terminals()).terminals).toContainEqual(
      expect.objectContaining({ id: createdTerminal.id }),
    );

    await stop(child);
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const restarted = await launch("start");
    expect((await readState()).token).toBe(firstState.token);
    const { epoch: nextEpoch } = (await (
      await fetch(`${origin}/api/terminal-operations`, {
        headers: terminalHeaders,
      })
    ).json()) as { epoch: string };
    const closeTerminalResponse = await fetch(
      `${origin}/api/terminal-operations`,
      {
        method: "POST",
        headers: terminalHeaders,
        body: JSON.stringify({
          operationId: randomUUID(),
          executor: { kind: "terminal", epoch: nextEpoch },
          intent: {
            command: "remove",
            params: { id: createdTerminal.id, force: true },
          },
        }),
      },
    );
    expect(closeTerminalResponse.ok).toBe(true);
    await stop(restarted);
  }, 240_000);
});
