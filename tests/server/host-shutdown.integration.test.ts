import {
  type ChildProcess,
  execFile as execFileCallback,
  spawn,
} from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testPiCommand } from "../../scripts/test-pi-command.mjs";
import {
  type InstanceState,
  stopManagedInstance,
} from "../../server/instance-state.mjs";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }),
  );
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolveListen) =>
    probe.listen(0, "127.0.0.1", resolveListen),
  );
  const address = probe.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP address");
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return address.port;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inspire-host-shutdown-"));
  roots.push(root);
  const port = await freePort();
  const path = join(root, "host.json");
  const env = isolatedTestEnvironment(root, {
    INSPIRE_PI_COMMAND: testPiCommand,
    INSPIRE_HOST: "127.0.0.1",
    INSPIRE_PORT: String(port),
    INSPIRE_STATE_PATH: path,
    INSPIRE_MOCK: "1",
    INSPIRE_TERMINAL_IN_PROCESS: "1",
    INSPIRE_OPEN: "0",
    INSPIRE_QUIET: "1",
  });
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(resolve("tests/fixtures/host-control-faults.mjs")).href,
      "--import",
      "tsx",
      resolve("server/index.ts"),
    ],
    { cwd: resolve("."), env, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr!.on("data", (chunk) => {
    output += String(chunk);
  });
  let state: InstanceState;
  await vi.waitFor(
    async () => {
      if (child.exitCode !== null)
        throw new Error("Host exited before readiness: " + output.slice(-2000));
      try {
        state = JSON.parse(await readFile(path, "utf8")) as InstanceState;
      } catch (error) {
        throw new Error(
          "Host has not published readiness: " + output.slice(-2000),
          { cause: error },
        );
      }
      expect(state.pid).toBe(child.pid);
      expect(state.shutdownControlVersion).toBe(1);
    },
    { timeout: 30_000, interval: 100 },
  );
  const health = () =>
    fetch("http://127.0.0.1:" + port + "/api/health", {
      headers: { Authorization: "Bearer " + state.token },
      signal: AbortSignal.timeout(1000),
    });
  expect((await health()).status).toBe(200);
  return {
    child,
    env,
    path,
    state: state!,
    health,
    async fault(command: string, marker: string) {
      child.stdin!.write(command + "\n");
      await vi.waitFor(() => expect(output).toContain(marker), {
        timeout: 3000,
      });
    },
    cli: () =>
      execFile(process.execPath, [resolve("inspire.mjs"), "stop"], {
        cwd: resolve("."),
        env,
        timeout: 30_000,
      }),
  };
}

describe("real Host local shutdown independent of HTTP", () => {
  it("treats an already-crashed owner as stale without requiring a cleanup receipt", async () => {
    const f = await fixture();
    const exited = new Promise((resolveExit) =>
      f.child.once("exit", resolveExit),
    );
    f.child.kill("SIGKILL");
    await exited;
    const result = await stopManagedInstance(f.path, {
      root: f.state.root,
      host: f.state.host,
      port: f.state.port,
    });
    expect(result).toEqual({ kind: "stale" });
    await expect(stat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(f.path + ".shutdown-request")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);
  it("stops an HTTP-unavailable Host through the CLI without affecting another Host", async () => {
    const first = await fixture();
    const other = await fixture();
    await first.fault("drop-http", "fixture-http-dropped");
    await expect(first.health()).rejects.toThrow();
    expect((await first.cli()).stdout).toContain("Stopped INSΠRE process");
    await vi.waitFor(() => expect(first.child.exitCode).toBe(0));
    await expect(stat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await other.health()).status).toBe(200);
    expect((await other.cli()).stdout).toContain("Stopped INSΠRE process");
  }, 60_000);

  it("reports cleanup failure instead of granting a replacement", async () => {
    const f = await fixture();
    await f.fault("fail-drain", "fixture-drain-armed");
    await expect(f.cli()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "could not confirm clean owned-worker shutdown",
      ),
    });
    await vi.waitFor(() => expect(f.child.exitCode).toBe(1));
    expect(
      JSON.parse(await readFile(f.path + ".shutdown-result", "utf8")).clean,
    ).toBe(false);
  }, 60_000);

  it("does not accept state disappearance and a signed clean result as process exit", async () => {
    const f = await fixture();
    await f.fault("stall-exit", "fixture-exit-armed");
    const result = await stopManagedInstance(
      f.path,
      {
        root: f.state.root,
        host: f.state.host,
        port: f.state.port,
      },
      { timeoutMs: 1500 },
    );
    expect(result.kind).toBe("timeout");
    await expect(stat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      JSON.parse(await readFile(f.path + ".shutdown-result", "utf8")).clean,
    ).toBe(true);
    expect(f.child.exitCode).toBeNull();
  }, 60_000);
});
