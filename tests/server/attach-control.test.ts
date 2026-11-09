import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTACH_CONTROL_STALE_MS,
  type AttachControlRecord,
  processIdentity,
} from "../../extensions/attach-control.js";
import {
  AttachControlConnection,
  AttachControlRegistry,
  preferredInstance,
} from "../../server/attach-control.js";
import { PiSessionActivity } from "../../server/pi-session-activity.js";
import type { SessionRecord } from "../../server/session-catalog.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "attach-control-"));
  roots.push(root);
  return root;
}

async function record(
  overrides: Partial<AttachControlRecord> = {},
): Promise<AttachControlRecord> {
  const instanceId = crypto.randomUUID();
  return {
    version: 1,
    instanceId,
    pid: process.pid,
    processIdentity: await processIdentity(process.pid),
    mode: "tui",
    cwd: "/work",
    sessionId: "one",
    sessionFile: "/work/one.jsonl",
    leafId: "leaf",
    activity: "idle",
    updatedAt: Date.now(),
    endpoint: "",
    token: "token",
    taskRuns: { instanceId, activeRunId: null, settled: [] },
    modelSelection: { model: null, thinkingLevel: "off" },
    ...overrides,
  };
}

async function save(root: string, value: AttachControlRecord) {
  const name = `${value.pid}-${value.instanceId}.json`;
  await writeFile(join(root, name), JSON.stringify(value));
  return name;
}

describe.skipIf(process.platform === "win32")("AttachControlRegistry", () => {
  it("lists live, fresh records and drops ones from exited processes", async () => {
    const root = await directory();
    const live = await record();
    await save(root, live);
    await save(
      root,
      await record({ updatedAt: Date.now() - ATTACH_CONTROL_STALE_MS - 1 }),
    );
    const exited = await save(
      root,
      await record({ processIdentity: "linux:another-birth" }),
    );
    const registry = new AttachControlRegistry(root);
    expect((await registry.list()).map((item) => item.instanceId)).toEqual([
      live.instanceId,
    ]);
    expect(await readdir(root)).not.toContain(exited);
    expect(await registry.forSession("one", "/work/one.jsonl")).toHaveLength(1);
    expect(await registry.forSession("one", "/work/other.jsonl")).toEqual([]);
  });

  it("reads only the asked process's records for its liveness and current session", async () => {
    const root = await directory();
    const own = await record();
    await save(root, own);
    // Another process's dead record: only a full scan reads and removes it.
    const other = await save(
      root,
      await record({ pid: process.ppid, processIdentity: "linux:gone" }),
    );
    const registry = new AttachControlRegistry(root);
    expect(await registry.forProcess(process.pid, own.processIdentity)).toEqual(
      {
        alive: true,
        records: [own],
      },
    );
    expect(await registry.alive(process.pid, "linux:another-birth")).toBe(
      false,
    );
    expect(await readdir(root)).toContain(other);
  });

  it("shares a recent scan among observers while list stays fresh", async () => {
    const root = await directory();
    const registry = new AttachControlRegistry(root);
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await registry.observe()).toEqual([]);
    const live = await record();
    await save(root, live);
    expect(await registry.observe()).toEqual([]);
    expect(await registry.list()).toEqual([live]);
    vi.advanceTimersByTime(1_000);
    expect(await registry.observe()).toEqual([live]);
  });

  it("treats a missing directory as no instances", async () => {
    const registry = new AttachControlRegistry(join(await directory(), "none"));
    expect(await registry.list()).toEqual([]);
  });
});

describe("preferredInstance", () => {
  it("prefers idle instances, then the most recent activity", async () => {
    const busy = await record({ activity: "working", updatedAt: 30 });
    const idleOld = await record({ activity: "idle", updatedAt: 10 });
    const idleNew = await record({ activity: "idle", updatedAt: 20 });
    expect(preferredInstance([busy, idleOld, idleNew])).toBe(idleNew);
    expect(preferredInstance([busy])).toBe(busy);
    expect(preferredInstance([])).toBeUndefined();
  });
});

describe("PiSessionActivity", () => {
  it("publishes the busiest live instance per catalogued session and path", async () => {
    const session: SessionRecord = {
      id: "one",
      path: "/work/one.jsonl",
      cwd: "/work",
      created: new Date(),
      modified: new Date(),
      messageCount: 1,
      firstMessage: "Task",
      source: null,
    };
    const publish = vi.fn();
    const observer = new PiSessionActivity({
      catalog: { refresh: vi.fn(async () => [session]) },
      registry: {
        observe: async () => [
          await record({ activity: "idle" }),
          await record({ activity: "working" }),
          await record({
            sessionFile: "/elsewhere/one.jsonl",
            activity: "blocked",
          }),
        ],
      },
      publish,
    });
    await observer.refresh();
    observer.close();
    expect(publish).toHaveBeenCalledWith({ one: "working" });
  });
});

describe("AttachControlConnection", () => {
  it("treats read failures as transient until they outlast the grace period", async () => {
    const live = await record({ endpoint: "/nonexistent/attach.sock" });
    const registry = {
      forProcess: vi.fn(async () => ({ alive: true, records: [] })),
    } as unknown as AttachControlRegistry;
    const connection = new AttachControlConnection(registry, live, 1_000);
    vi.useFakeTimers();
    // A reload: the live process briefly has no record.
    await expect(connection.read()).rejects.toThrow("reloading");
    vi.advanceTimersByTime(500);
    await expect(connection.read()).rejects.toThrow("reloading");
    // An unreachable endpoint counts toward the same period.
    vi.mocked(registry.forProcess).mockResolvedValue({
      alive: true,
      records: [live],
    });
    await expect(connection.read()).rejects.toMatchObject({
      code: "SESSION_OWNER_UNAVAILABLE",
    });
    vi.advanceTimersByTime(600);
    await expect(connection.read()).resolves.toEqual({ ended: "unreachable" });
  });

  it("ends the binding at once, saying whether the process exited or moved to another session", async () => {
    const live = await record({ endpoint: "/nonexistent/attach.sock" });
    const registry = {
      forProcess: vi.fn(async () => ({ alive: false, records: [] })),
    } as unknown as AttachControlRegistry;
    const connection = new AttachControlConnection(registry, live, 60_000);
    await expect(connection.read()).resolves.toEqual({ ended: "exited" });
    vi.mocked(registry.forProcess).mockResolvedValue({
      alive: true,
      records: [{ ...live, sessionFile: "/work/other.jsonl" }],
    });
    await expect(connection.read()).resolves.toEqual({ ended: "left-session" });
  });
});
