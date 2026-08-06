import { createServer } from "node:http";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "inspire");
const children: ChildProcess[] = [];
const temporaryDirectories: string[] = [];
let activeEnvironment: NodeJS.ProcessEnv | null = null;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return port;
}

function launcherEnv(statePath: string, port: number, home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    INSPIRE_HOST: "127.0.0.1",
    INSPIRE_PORT: String(port),
    INSPIRE_STATE_PATH: statePath,
    INSPIRE_OPEN: "0",
  };
}

function runLauncher(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(launcher, args, { cwd: root, env, encoding: "utf8", timeout: 30_000 });
}

async function waitFor(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for isolated launcher acceptance");
}

afterEach(async () => {
  if (activeEnvironment) {
    try {
      runLauncher(["stop"], activeEnvironment);
    } catch {
      // The child may already have exited; cleanup below still removes only
      // this test's temporary directory.
    }
    activeEnvironment = null;
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("production launcher", () => {
  it("restarts without an existing instance and owns one isolated lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-launcher-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "instance.json");
    const port = await freePort();
    const env = launcherEnv(statePath, port, join(directory, "home"));
    expect(runLauncher(["stop"], env)).toContain("No managed insπre instance is running.");
    const output: Buffer[] = [];
    const child = spawn(launcher, ["restart"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    activeEnvironment = env;
    children.push(child);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));

    await waitFor(() => {
      try {
        return runLauncher(["status"], env).startsWith("insπre is running.");
      } catch {
        return false;
      }
    });
    const firstState = JSON.parse(await readFile(statePath, "utf8")) as { schemaVersion: number; token: string };
    expect(firstState.schemaVersion).toBe(1);
    expect(Buffer.concat(output).toString()).toContain("No managed insπre instance is running.");

    const stopOutput = runLauncher(["stop"], env);
    expect(stopOutput).toContain("Stopped insπre process");
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("close", (code) => resolveExit(code)));
    expect(exitCode).toBe(0);
    activeEnvironment = null;
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const restarted = spawn(launcher, ["start"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    activeEnvironment = env;
    children.push(restarted);
    await waitFor(() => {
      try {
        return runLauncher(["status"], env).startsWith("insπre is running.");
      } catch {
        return false;
      }
    });
    const secondState = JSON.parse(await readFile(statePath, "utf8")) as { token: string };
    expect(secondState.token).toBe(firstState.token);
    expect(runLauncher(["stop"], env)).toContain("Stopped insπre process");
    const restartedExit = restarted.exitCode ?? await new Promise<number | null>((resolveExit) => restarted.once("close", resolveExit));
    expect(restartedExit).toBe(0);
    activeEnvironment = null;
  }, 120_000);
});
