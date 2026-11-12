import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
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
  takeoverCandidate,
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
    taskRuns: { instanceId, settled: [] },
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
  it("keeps an expired record from a live process for writer admission", async () => {
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
    expect(await registry.forSession("one", "/work/one.jsonl")).toEqual([live]);
    expect(await readdir(root)).not.toContain(exited);
    expect(
      await registry.branchLeaves("one", "/work/one.jsonl", {
        observe: false,
        isAncestor: () => false,
      }),
    ).toEqual(expect.arrayContaining(["leaf", undefined]));
    expect(await registry.forSession("one", "/work/other.jsonl")).toEqual([]);
  });

  it("scopes process lookups and checks ownership again after exit", async () => {
    const root = await directory();
    const child = spawn(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    try {
      await once(child, "spawn");
      const live = await record({
        pid: child.pid!,
        processIdentity: await processIdentity(child.pid!),
      });
      const name = await save(root, live);
      const stale = await save(
        root,
        await record({ processIdentity: "linux:gone" }),
      );
      const registry = new AttachControlRegistry(root);
      expect(await registry.forProcess(live.pid, live.processIdentity)).toEqual(
        {
          alive: true,
          records: [live],
        },
      );
      expect(await registry.alive(live.pid, "linux:another-birth")).toBe(false);
      expect(await readdir(root)).toContain(stale);
      expect(await registry.observe()).toEqual([live]);

      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
      expect(
        await registry.forSession(live.sessionId, live.sessionFile),
      ).toEqual([]);
      expect(await readdir(root)).not.toContain(name);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  });

  it("identifies symlink and hardlink aliases by file identity within one session", async () => {
    const root = await directory();
    const file = join(root, "session.jsonl");
    const symlinked = join(root, "alias.jsonl");
    const hardlinked = join(root, "hardlink.jsonl");
    const copied = join(root, "copy.jsonl");
    await writeFile(file, "same content\n");
    await Promise.all([
      symlink(file, symlinked),
      link(file, hardlinked),
      writeFile(copied, "same content\n"),
    ]);
    const live = await record({ sessionFile: symlinked });
    await save(root, live);
    const registry = new AttachControlRegistry(root);
    expect(await registry.forSession("one", file)).toEqual([live]);
    expect(await registry.forSession("one", hardlinked)).toEqual([live]);
    expect(await registry.forSession("one", copied)).toEqual([]);
    expect(await registry.forSession("another", file)).toEqual([]);
  });

  it("caches an empty observation while writer admission immediately sees a new registry", async () => {
    const root = join(await directory(), "not-created-yet");
    const registry = new AttachControlRegistry(root);
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await registry.observe()).toEqual([]);
    await mkdir(root);
    const live = await record();
    await save(root, live);
    expect(await registry.observe()).toEqual([]);
    expect(await registry.forSession(live.sessionId, live.sessionFile)).toEqual(
      [live],
    );
    vi.advanceTimersByTime(1_000);
    expect(await registry.observe()).toEqual([live]);
  });

  it("verifies reported ancestors while retaining uncertainty when Pi cannot answer", async () => {
    const root = await directory();
    const endpoint = join(root, "pi.sock");
    const live = await record({ endpoint, leafId: "old" });
    await save(root, live);
    const registry = new AttachControlRegistry(root);
    const request = vi.fn();
    const server = createServer((socket) => {
      socket.once("data", (line) => {
        request(JSON.parse(line.toString()));
        socket.end(
          `${JSON.stringify({
            ok: true,
            state: { ...live, leafId: "current" },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    const leaves = (isAncestor: (leaf: string | null) => boolean) =>
      registry.branchLeaves(live.sessionId, live.sessionFile, {
        observe: false,
        isAncestor,
      });
    try {
      expect(await leaves(() => false)).toEqual(["old"]);
      expect(request).not.toHaveBeenCalled();
      expect(await leaves((leaf) => leaf === "old")).toEqual(["current"]);
      expect(request).toHaveBeenCalledExactlyOnceWith({
        op: "state",
        token: live.token,
        sessionFile: live.sessionFile,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await leaves((leaf) => leaf === "old")).toEqual([undefined]);
  });

  it("distinguishes registry scan failure from no instances", async () => {
    const path = join(await directory(), "not-a-directory");
    await writeFile(path, "");
    const registry = new AttachControlRegistry(path);
    await expect(registry.observe()).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(
      registry.forSession("one", "/work/one.jsonl"),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("takeoverCandidate", () => {
  it("prefers the current branch for explicit takeover and requires one idle owner for automatic takeover", async () => {
    const current = await record({ endpoint: "/work/current" });
    const ancestor = await record({ leafId: "old", endpoint: "/work/old" });
    const presenceOnly = await record({ leafId: "old" });
    const busy = { ...current, activity: "working" as const };
    const unrelated = { ...presenceOnly, leafId: "sibling" };
    const match = (leaf: string | null) => {
      if (leaf === "leaf") return "continues";
      return leaf === "old" ? "possible" : "other";
    };
    expect(
      takeoverCandidate(
        [ancestor, { ...presenceOnly, leafId: current.leafId }, current],
        match,
      ),
    ).toBe(current);
    expect(takeoverCandidate([ancestor], match)).toBe(ancestor);
    expect(takeoverCandidate([presenceOnly], match)).toBeUndefined();
    expect(takeoverCandidate([current, unrelated], match, true)).toBe(current);
    expect(
      takeoverCandidate([current, presenceOnly], match, true),
    ).toBeUndefined();
    expect(takeoverCandidate([busy], match, true)).toBeUndefined();
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

  it.each(["exited", "left-session"] as const)(
    "ends the binding immediately when the owner has %s",
    async (ended) => {
      const live = await record({ endpoint: "/nonexistent/attach.sock" });
      const registry = {
        forProcess: async () =>
          ended === "exited"
            ? { alive: false, records: [] }
            : {
                alive: true,
                records: [{ ...live, sessionFile: "/work/other.jsonl" }],
              },
      } as unknown as AttachControlRegistry;
      const connection = new AttachControlConnection(registry, live, 60_000);
      await expect(connection.read()).resolves.toEqual({ ended });
    },
  );

  it.skipIf(process.platform === "win32")(
    "distinguishes a lost or invalid reply from an explicit refusal or a failed connect",
    async () => {
      const endpoint = join(await directory(), "pi.sock");
      const live = await record({ endpoint });
      const registry = {
        forProcess: async () => ({ alive: true, records: [live] }),
      } as unknown as AttachControlRegistry;
      const connection = new AttachControlConnection(registry, live);
      await expect(connection.prompt("hello")).rejects.toMatchObject({
        code: "SESSION_OWNER_UNAVAILABLE",
      });

      const replies: Array<(socket: Socket) => void> = [
        (socket) => socket.destroy(),
        (socket) =>
          socket.end(
            `${JSON.stringify({
              ok: true,
              state: { ...live, leafId: undefined },
              witnessed: true,
            })}\n`,
          ),
        (socket) =>
          socket.end('{"ok":false,"code":"BLOCKED","error":"waiting"}\n'),
      ];
      const server = createServer((socket) => {
        socket.once("data", () => replies.shift()?.(socket));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, resolve);
      });
      try {
        for (let i = 0; i < 2; i += 1) {
          await expect(connection.prompt("hello")).rejects.toMatchObject({
            code: "ATTACH_CONTROL_OUTCOME_UNKNOWN",
            outcomeUnknown: true,
          });
        }
        await expect(connection.prompt("hello")).rejects.toMatchObject({
          code: "NATIVE_INPUT_BLOCKED",
          message: "waiting",
        });
        expect(replies).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
