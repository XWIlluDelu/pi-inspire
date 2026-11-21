import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeInstanceShutdown,
  consumeStopRequest,
  INSTANCE_STATE_VERSION,
  type InstanceState,
  inspectInstance,
  instanceShutdownRequested,
  instanceUrl,
  portAvailable,
  processStartIdentity,
  removeInstanceState,
  requestInstanceShutdown,
  stopManagedInstance,
  watchInstanceShutdown,
  writeInstanceState,
} from "../../server/instance-state.mjs";

let directory: string;
let closeMonitor: (() => void) | undefined;

afterEach(async () => {
  closeMonitor?.();
  closeMonitor = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function temporaryStatePath(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "inspire-instance-"));
  return join(directory, "instance.json");
}

function state(port = 4587): InstanceState {
  return {
    schemaVersion: INSTANCE_STATE_VERSION,
    pid: process.pid,
    root: process.cwd(),
    host: "127.0.0.1",
    port,
    token: "test-token-with-sufficient-entropy",
    startedAt: new Date().toISOString(),
    processStartTime: "test-process-start",
  };
}

describe("Inspire instance state", () => {
  it("cancels a dedicated foreign-PID birth query without changing default lookup", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      { stdio: "ignore", windowsHide: true },
    );
    try {
      await once(child, "spawn");
      const controller = new AbortController();
      controller.abort();
      await expect(
        processStartIdentity(child.pid!, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await processStartIdentity(child.pid!)).toEqual(
        expect.any(String),
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  });

  it("does not cancel or poison the shared immutable self-birth cache", async () => {
    const birth = await processStartIdentity(process.pid);
    const controller = new AbortController();
    controller.abort();
    expect(await processStartIdentity(process.pid, controller.signal)).toBe(
      birth,
    );
    expect(await processStartIdentity(process.pid)).toBe(birth);
  });

  it("writes private atomic state and removes only the exact owner", async () => {
    const path = await temporaryStatePath();
    const value = state();
    await writeInstanceState(path, value);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(value);
    expect(instanceUrl(value)).toBe("http://127.0.0.1:4587/");
    expect(instanceUrl({ ...value, host: "::1" })).toBe("http://[::1]:4587/");
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    await removeInstanceState(path, { ...value, token: "different-owner" });
    await expect(stat(path)).resolves.toBeDefined();
    await removeInstanceState(path, value);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });

    const requestPath = `${path}.stop-request`;
    await writeInstanceState(path, value);
    await writeFile(requestPath, "stop\n", { mode: 0o600 });
    await expect(consumeStopRequest(requestPath)).resolves.toBe(true);
    await expect(consumeStopRequest(requestPath)).resolves.toBe(false);
  });

  it("fails closed on corrupt, foreign and reused instance publications", async () => {
    const path = await temporaryStatePath();
    const owner = {
      ...state(),
      processStartTime: await processStartIdentity(process.pid),
    };
    const target = { root: owner.root, host: owner.host, port: owner.port };
    for (const invalid of [
      "not-json",
      JSON.stringify({ ...owner, schemaVersion: 1 }),
    ]) {
      await writeFile(path, invalid, { mode: 0o600 });
      await expect(inspectInstance(path, target)).rejects.toThrow();
      await expect(stopManagedInstance(path, target)).rejects.toThrow();
    }
    await expect(stat(path + ".shutdown-request")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeInstanceState(path, owner);
    await expect(
      stopManagedInstance(path, { ...target, root: owner.root + "-other" }),
    ).resolves.toEqual({ kind: "stale" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(owner);
    await writeInstanceState(path, {
      ...owner,
      processStartTime: owner.processStartTime + "-reused",
    });
    await expect(inspectInstance(path, target)).resolves.toEqual({
      kind: "stale",
    });
  });

  it("matches installation roots by their identity on the actual volume", async () => {
    const path = await temporaryStatePath();
    const lower = path + "-root";
    const upper = path + "-ROOT";
    await mkdir(lower);
    const distinct = (await mkdir(upper, { recursive: true })) !== undefined;
    const owner = {
      ...state(),
      root: lower,
      processStartTime: await processStartIdentity(process.pid),
    };
    await writeInstanceState(path, owner);
    // Windows directories can be case-sensitive. Exercise that combination
    // even when the test volume belongs to another operating system.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    if (distinct) Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const result = await inspectInstance(path, {
        root: upper,
        host: owner.host,
        port: owner.port,
      });
      expect(result.kind).toBe(distinct ? "stale" : "unavailable");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  }, 30_000);

  it("reports port ownership without disturbing the listener", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as import("node:net").AddressInfo;
    try {
      await expect(portAvailable("127.0.0.1", port)).resolves.toBe(false);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await expect(portAvailable("127.0.0.1", port)).resolves.toBe(true);
  });
});

async function shutdownFixture() {
  const path = await temporaryStatePath();
  return {
    path,
    state: {
      ...state(),
      root: dirname(path),
      startedAt: "2026-10-19T00:00:00Z",
    },
  };
}

describe("authenticated local Host shutdown", () => {
  it.runIf(process.platform !== "win32")(
    "rejects a FIFO without blocking filesystem workers",
    async () => {
      const f = await shutdownFixture();
      await promisify(execFile)("mkfifo", [f.path + ".shutdown-request"]);
      expect(await instanceShutdownRequested(f.path, f.state)).toBe(false);
    },
  );
  it("authenticates a private shutdown request and completes it once", async () => {
    const f = await shutdownFixture();
    const path = f.path + ".shutdown-request";
    await requestInstanceShutdown(f.path, f.state);
    const original = await readFile(path, "utf8");
    expect(Buffer.byteLength(original)).toBeLessThan(2048);
    expect(original).not.toContain(f.state.token);
    expect(original).not.toContain(f.state.root);
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);

    const request = JSON.parse(original);
    await writeFile(path, JSON.stringify({ ...request, scope: "host-only" }));
    expect(await instanceShutdownRequested(f.path, f.state)).toBe(false);
    await writeFile(path, original);
    expect(await instanceShutdownRequested(f.path, f.state)).toBe(true);

    const shutdown = vi.fn(async () => {
      await completeInstanceShutdown(f.path, f.state, true);
    });
    closeMonitor = watchInstanceShutdown(f.path, f.state, shutdown);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    await shutdown.mock.results[0]!.value;
    expect(await instanceShutdownRequested(f.path, f.state)).toBe(false);
    expect(await readFile(f.path + ".shutdown-result", "utf8")).not.toContain(
      f.state.token,
    );
  });

  it("binds file shutdown to the credential, process incarnation and configuration", async () => {
    const f = await shutdownFixture();
    for (const change of [
      { token: "different-token" },
      { pid: process.pid + 1 },
      { processStartTime: "reused-pid" },
      { startedAt: "2026-10-19T00:00:01Z" },
      { root: "different-installation" },
      { host: "localhost" },
      { port: 41235 },
    ]) {
      await requestInstanceShutdown(f.path, { ...f.state, ...change });
      expect(
        await instanceShutdownRequested(f.path, f.state),
        JSON.stringify(change),
      ).toBe(false);
    }
  });

  it("rejects an expired authentic request and tampered payload/MAC", async () => {
    const f = await shutdownFixture();
    await requestInstanceShutdown(f.path, f.state, -1);
    expect(await instanceShutdownRequested(f.path, f.state)).toBe(false);
    await requestInstanceShutdown(f.path, f.state);
    const original = JSON.parse(
      await readFile(f.path + ".shutdown-request", "utf8"),
    );
    await writeFile(
      f.path + ".shutdown-request",
      JSON.stringify({ ...original, expiresAt: original.expiresAt + 1 }),
    );
    expect(await instanceShutdownRequested(f.path, f.state)).toBe(false);
    await writeFile(
      f.path + ".shutdown-request",
      JSON.stringify({ ...original, signature: "X".repeat(43) }),
    );
    expect(await instanceShutdownRequested(f.path, f.state)).toBe(false);
    await writeFile(f.path + ".shutdown-request", "x".repeat(4096));
    expect(await instanceShutdownRequested(f.path, f.state)).toBe(false);
  });

  it("never runs a disposed monitor, including a request already being read", async () => {
    const f = await shutdownFixture();
    await requestInstanceShutdown(f.path, f.state);
    const shutdown = vi.fn(async () => {});
    const close = watchInstanceShutdown(f.path, f.state, shutdown);
    close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(shutdown).not.toHaveBeenCalled();
  });
});
