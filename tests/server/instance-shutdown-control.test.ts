import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeInstanceShutdown,
  type InstanceState,
  instanceShutdownRequested,
  requestInstanceShutdown,
  watchInstanceShutdown,
} from "../../server/instance-state.mjs";

const roots: string[] = [];
const controls: (() => void)[] = [];
afterEach(async () => {
  controls.splice(0).forEach((close) => close());
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inspire-shutdown-control-"));
  roots.push(root);
  const path = join(root, "host.json");
  const state: InstanceState = {
    schemaVersion: 1,
    pid: process.pid,
    root,
    host: "127.0.0.1",
    port: 41234,
    token: "private-owner-token",
    startedAt: "2026-10-19T00:00:00Z",
    processStartTime: "original-process-birth",
    mock: false,
    shutdownControlVersion: 1,
  };
  return { root, path, state };
}

describe("authenticated local Host shutdown", () => {
  it.runIf(process.platform !== "win32")(
    "rejects a FIFO without blocking filesystem workers",
    async () => {
      const f = await fixture();
      await promisify(execFileCallback)("mkfifo", [
        f.path + ".shutdown-request",
      ]);
      expect(await instanceShutdownRequested(f.path, f.state)).toBe(false);
    },
  );
  it("publishes bounded private authenticated records without serializing the token", async () => {
    const f = await fixture();
    await requestInstanceShutdown(f.path, f.state);
    const text = await readFile(f.path + ".shutdown-request", "utf8");
    expect(Buffer.byteLength(text)).toBeLessThan(2048);
    expect(text).not.toContain(f.state.token);
    expect(text).not.toContain(f.state.root);
    if (process.platform !== "win32")
      expect((await stat(f.path + ".shutdown-request")).mode & 0o777).toBe(
        0o600,
      );
    expect(await instanceShutdownRequested(f.path, f.state)).toBe(true);
    await completeInstanceShutdown(f.path, f.state, true);
    expect(await instanceShutdownRequested(f.path, f.state)).toBe(false);
    expect(await readFile(f.path + ".shutdown-result", "utf8")).not.toContain(
      f.state.token,
    );
  });

  it.each([
    { token: "different-token" },
    { pid: process.pid + 1 },
    { processStartTime: "reused-pid" },
    { startedAt: "2026-10-19T00:00:01Z" },
    { root: "different-installation" },
    { host: "localhost" },
    { port: 41235 },
    { mock: true },
  ])(
    "rejects other credentials, incarnation or configuration: %j",
    async (change) => {
      const f = await fixture();
      await requestInstanceShutdown(f.path, { ...f.state, ...change });
      expect(await instanceShutdownRequested(f.path, f.state)).toBe(false);
    },
  );

  it("rejects an expired authentic request and tampered payload/MAC", async () => {
    const f = await fixture();
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

  it("runs cooperative shutdown once and keeps a stopped monitor inert", async () => {
    const f = await fixture();
    const shutdown = vi.fn(async () => {
      await completeInstanceShutdown(f.path, f.state, true);
    });
    const close = watchInstanceShutdown(f.path, f.state, shutdown);
    controls.push(close);
    await requestInstanceShutdown(f.path, f.state);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce(), {
      timeout: 2000,
    });
    // Invocation precedes async mailbox cleanup. Finish that first action
    // before testing whether a disposed monitor leaves a new request alone.
    await shutdown.mock.results[0]!.value;
    close();
    await requestInstanceShutdown(f.path, f.state);
    expect(await instanceShutdownRequested(f.path, f.state)).toBe(true);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("never runs a disposed monitor, including a request already being read", async () => {
    const f = await fixture();
    await requestInstanceShutdown(f.path, f.state);
    const shutdown = vi.fn(async () => {});
    const close = watchInstanceShutdown(f.path, f.state, shutdown);
    close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(shutdown).not.toHaveBeenCalled();
  });
});
