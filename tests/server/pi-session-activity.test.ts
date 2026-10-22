import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import reportActivity, {
  ACTIVITY_HEARTBEAT_MS,
  ACTIVITY_STALE_MS,
  piActivityDirectory,
  type PiActivityRecord,
} from "../../docs/examples/session-activity.js";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { PiSessionActivity } from "../../server/pi-session-activity.js";
import { PiSessionOccupancy } from "../../server/pi-session-occupancy.js";
import type { SessionRecord } from "../../server/session-catalog.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

const paths = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => paths.home,
}));

const observers: PiSessionActivity[] = [];
const reporters: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  // Unit reporters are not running inside the parent agent’s Herdr pane.
  vi.stubEnv("HERDR_PANE_ID", "");
  paths.home = await mkdtemp(join(tmpdir(), "inspire-pi-activity-"));
  vi.stubEnv("XDG_CACHE_HOME", join(paths.home, "cache"));
  vi.stubEnv("LOCALAPPDATA", join(paths.home, "local"));
  vi.stubEnv("INSPIRE_BRANCH_COMMAND", undefined);
});
afterEach(async () => {
  await Promise.all(reporters.splice(0).map((stop) => stop()));
  observers.splice(0).forEach((observer) => observer.close());
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(paths.home, { recursive: true, force: true });
});

function session(
  id = "one",
  path = join(paths.home, "one.jsonl"),
): SessionRecord {
  return {
    id,
    path,
    cwd: paths.home,
    created: new Date(),
    modified: new Date(),
    messageCount: 1,
    firstMessage: "Task",
    source: null,
  };
}
async function save(overrides: Partial<PiActivityRecord> = {}) {
  const record: PiActivityRecord = {
    version: 1,
    pid: process.pid,
    sessionId: "one",
    sessionFile: session().path,
    activity: "working",
    updatedAt: Date.now(),
    ...overrides,
  };
  const directory = piActivityDirectory();
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${record.pid}-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(record));
  return path;
}
function fixture() {
  const catalog = { refresh: vi.fn(async () => [session()]) };
  const publish = vi.fn();
  const observer = new PiSessionActivity({ catalog, publish });
  observers.push(observer);
  return { catalog, publish, observer };
}

describe("local Pi session observations", () => {
  it("requires both catalog identity and path and counts duplicate reports only once", async () => {
    const { catalog, publish, observer } = fixture();
    await save({ activity: "idle" });
    await save();
    await save({ sessionId: "unknown" });
    await save({
      sessionId: "one",
      sessionFile: join(paths.home, "wrong.jsonl"),
    });
    await observer.refresh();
    expect(publish).toHaveBeenLastCalledWith({ one: "working" });
    await observer.refresh();
    expect(publish).toHaveBeenCalledTimes(2); // baseline for reconnecting clients

    catalog.refresh.mockResolvedValue([
      session(),
      session("one", join(paths.home, "duplicate.jsonl")),
    ]);
    await observer.refresh();
    expect(publish).toHaveBeenLastCalledWith({});
  });

  it("clears expired, exited and removed reports rather than inventing idle state", async () => {
    const { publish, observer } = fixture();
    const live = await save();
    await observer.refresh();
    expect(publish).toHaveBeenLastCalledWith({ one: "working" });
    await rm(live);
    await save({ updatedAt: Date.now() - ACTIVITY_STALE_MS });
    await save({ updatedAt: Date.now() + ACTIVITY_STALE_MS });
    await save({ version: 2 as 1 });
    await save({ inactive: true });
    await save({ released: true });
    const dead = await save({ pid: 2_147_483_647 });
    await observer.refresh();
    expect(publish).toHaveBeenLastCalledWith({});
    await expect(readFile(dead)).rejects.toMatchObject({ code: "ENOENT" });

    await rm(piActivityDirectory(), { recursive: true });
    await observer.refresh();
    expect(publish).toHaveBeenLastCalledWith({});
  });

  it("expires a stalled catalog lookup and ignores late results after close", async () => {
    vi.useFakeTimers();
    const { catalog, publish, observer } = fixture();
    await save();
    await observer.refresh();
    let complete!: (records: SessionRecord[]) => void;
    catalog.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = observer.refresh();
    await vi.waitFor(() => expect(catalog.refresh).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(ACTIVITY_STALE_MS);
    expect(publish).toHaveBeenLastCalledWith({});
    complete([session()]);
    await pending;
    expect(publish).toHaveBeenLastCalledWith({});

    await save();
    const closing = observer.refresh();
    await vi.waitFor(() => expect(catalog.refresh).toHaveBeenCalledTimes(3));
    observer.close();
    const before = publish.mock.calls.length;
    complete([session()]);
    await closing;
    expect(publish).toHaveBeenCalledTimes(before);
  });
});

function reporter(
  mode: ExtensionContext["mode"] = "tui",
  sharedContext?: ExtensionContext,
) {
  type Handler = (
    event: Record<string, unknown>,
    ctx: ExtensionContext,
  ) => unknown;
  const handlers = new Map<string, Handler>();
  const idle = vi.fn(() => true);
  const commands = vi.fn(() => [] as { name: string }[]);
  let identity = session();
  const context =
    sharedContext ??
    ({
      mode,
      cwd: paths.home,
      isIdle: idle,
      ui: { onTerminalInput: vi.fn(() => () => {}) },
      sessionManager: {
        getSessionId: () => identity.id,
        getSessionFile: () => identity.path,
      },
    } as unknown as ExtensionContext);
  reportActivity({
    getCommands: commands,
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI);
  const emit = async (type: string, extra: Record<string, unknown> = {}) => {
    await handlers.get(type)?.(
      {
        type,
        ...(type === "session_shutdown" ? { reason: "quit" } : {}),
        ...extra,
      },
      context,
    );
  };
  reporters.push(() => emit("session_shutdown"));
  const records = async (): Promise<PiActivityRecord[]> => {
    const names = await readdir(piActivityDirectory()).catch(() => []);
    const reports: PiActivityRecord[] = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) =>
          JSON.parse(await readFile(join(piActivityDirectory(), name), "utf8")),
        ),
    );
    return reports;
  };
  const activeRecords = async () =>
    (await records()).filter((record) => !record.inactive && !record.released);
  return {
    emit,
    idle,
    commands,
    context,
    records: activeRecords,
    storedRecords: records,
    setSession: (next: SessionRecord) => {
      identity = next;
    },
  };
}

describe("optional native Pi activity reporter", () => {
  it("keeps presence while a later SDK shutdown handler is pending and after in-process disposal", async () => {
    const first = reporter("rpc");
    first.idle.mockReturnValue(false);
    await first.emit("session_start");
    await writeFile(session().path, "");
    const guard = new PiSessionOccupancy();
    const active = { code: "EXTERNAL_PI_WRITER_ACTIVE" };
    await expect(
      guard.assertWritable("one", session().path),
    ).rejects.toMatchObject(active);

    let continueShutdown!: () => void, enteredCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      continueShutdown = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredCleanup = resolve;
    });
    const dispose = vi.fn();
    type RuntimeArgs = ConstructorParameters<typeof AgentSessionRuntime>;
    const runtime = new AgentSessionRuntime(
      {
        extensionRunner: {
          hasHandlers: (event: string) => event === "session_shutdown",
          emit: async (event: { type: string; reason: string }) => {
            await first.emit(event.type, event);
            enteredCleanup();
            await cleanup;
          },
        },
        dispose,
      } as unknown as RuntimeArgs[0],
      {} as RuntimeArgs[1],
      async () => {
        throw new Error("This test must not create another SDK session");
      },
    );
    const closing = runtime.dispose();
    try {
      await entered;
      expect(dispose).not.toHaveBeenCalled();
      expect(await first.storedRecords()).toMatchObject([{ inactive: true }]);
      expect((await first.storedRecords())[0]!.released).toBeUndefined();
      await expect(
        guard.assertWritable("one", session().path),
      ).rejects.toMatchObject(active);
    } finally {
      continueShutdown();
      await closing;
    }
    expect(dispose).toHaveBeenCalledOnce();
    // SDK disposal is not process exit or a post-disposal writer-drain signal.
    await expect(
      guard.assertWritable("one", session().path),
    ).rejects.toMatchObject(active);
  });

  it("does not arm a heartbeat after shutdown overtakes an asynchronous startup publication", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const originalRename = vi.mocked(rename).getMockImplementation()!;
    let continueRename!: () => void, enteredRename!: () => void;
    const proceed = new Promise<void>((resolve) => {
      continueRename = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredRename = resolve;
    });
    vi.mocked(rename).mockImplementationOnce(async (...args) => {
      enteredRename();
      await proceed;
      return originalRename(...args);
    });
    const f = reporter("rpc");
    const starting = f.emit("session_start");
    await entered;
    const closing = f.emit("session_shutdown");
    continueRename();
    await Promise.all([starting, closing]);
    expect(vi.getTimerCount()).toBe(0);
    expect(await f.records()).toEqual([]);
    expect(await f.storedRecords()).toMatchObject([{ inactive: true }]);
  });

  it.each(["tui", "rpc", "json", "print"] as const)(
    "reports %s startup, work, input waiting and final settlement without ending at agent_end",
    async (mode) => {
      const { emit, idle, records } = reporter(mode);
      expect(await records()).toEqual([]); // discovery/factory has no runtime side effects
      await emit("session_start");
      expect(await records()).toMatchObject([
        { sessionId: "one", activity: "idle" },
      ]);
      await emit("before_agent_start");
      await emit("agent_start");
      await emit("agent_end");
      expect(await records()).toMatchObject([{ activity: "working" }]);
      idle.mockReturnValue(false);
      await emit("ui_prompt_start");
      expect(await records()).toMatchObject([{ activity: "blocked" }]);
      await emit("ui_prompt_end");
      expect(await records()).toMatchObject([{ activity: "working" }]);
      idle.mockReturnValue(true);
      await emit("agent_settled");
      expect(await records()).toMatchObject([{ activity: "idle" }]);
      await emit("session_shutdown");
      await emit("session_shutdown");
      expect(await records()).toEqual([]);
    },
  );

  it("preserves one presence record across extension-factory reload and stops activity on shutdown", async () => {
    const first = reporter("rpc");
    await first.emit("session_start");
    await first.emit("session_shutdown", { reason: "reload" });
    expect(await first.records()).toMatchObject([
      { sessionId: "one", processIdentity: expect.any(String) },
    ]);
    const replacement = reporter("rpc", first.context);
    await replacement.emit("session_start", { reason: "reload" });
    expect(await replacement.records()).toHaveLength(1);
    // Old runtime cleanup must not release its replacement's presence.
    await first.emit("session_shutdown");
    expect(await replacement.records()).toHaveLength(1);
    await replacement.emit("session_shutdown", { reason: "resume" });
    expect(await replacement.records()).toEqual([]);
  });

  it("does not stop activity for another SDK session sharing the same process", async () => {
    const first = reporter("rpc"),
      second = reporter("rpc");
    await first.emit("session_start");
    await second.emit("session_start");
    expect(await first.records()).toHaveLength(2);
    await first.emit("session_shutdown");
    expect(await second.records()).toHaveLength(1);
    await second.emit("session_shutdown");
    expect(await second.records()).toEqual([]);
  });

  it.each(["new", "resume", "fork"] as const)(
    "rebinds only after %s replacement and lets an old SDK manager be reused independently",
    async (reason) => {
      const original = session(),
        next = session("two", join(paths.home, "two.jsonl"));
      await writeFile(original.path, "");
      await writeFile(next.path, "");
      const first = reporter("rpc");
      const previousManager = first.context.sessionManager;
      await first.emit("session_start");
      const firstNames = (await readdir(piActivityDirectory())).filter((name) =>
        name.endsWith(".json"),
      );
      await first.emit("session_shutdown", {
        reason,
        targetSessionFile: next.path,
      });
      const guard = new PiSessionOccupancy();
      await expect(
        guard.assertWritable(original.id, original.path),
      ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });

      const replacement = reporter("rpc");
      replacement.setSession(next);
      await replacement.emit("session_start", {
        reason,
        previousSessionFile: original.path,
      });
      expect(await replacement.storedRecords()).toMatchObject([
        { sessionId: next.id },
      ]);
      expect(
        (await readdir(piActivityDirectory())).filter((name) =>
          name.endsWith(".json"),
        ),
      ).toEqual(firstNames);
      await expect(
        guard.assertWritable(original.id, original.path),
      ).resolves.toBeUndefined();
      await expect(
        guard.assertWritable(next.id, next.path),
      ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });

      const independent = reporter("rpc", {
        ...first.context,
        sessionManager: previousManager,
      });
      await independent.emit("session_start");
      expect(await independent.records()).toHaveLength(2);
      expect(
        (await independent.records()).map((r) => r.sessionId).sort(),
      ).toEqual([original.id, next.id].sort());
      await first.emit("session_shutdown"); // late old cleanup cannot overwrite the replacement
      await expect(
        guard.assertWritable(next.id, next.path),
      ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });
    },
  );

  it("keeps the old fence when a new start does not match the shutdown target", async () => {
    const original = session(),
      target = session("two", join(paths.home, "two.jsonl"));
    await writeFile(original.path, "");
    const first = reporter("rpc");
    await first.emit("session_start");
    await first.emit("session_shutdown", {
      reason: "resume",
      targetSessionFile: target.path,
    });
    const unrelated = reporter("rpc");
    unrelated.setSession(session("three", join(paths.home, "three.jsonl")));
    await unrelated.emit("session_start", {
      reason: "resume",
      previousSessionFile: original.path,
    });
    expect(await unrelated.storedRecords()).toHaveLength(2);
    await expect(
      new PiSessionOccupancy().assertWritable(original.id, original.path),
    ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });
  });

  it("does not guess between ambiguous SDK replacement producers", async () => {
    const original = session(),
      target = session("two", join(paths.home, "two.jsonl"));
    await writeFile(original.path, "");
    const first = reporter("rpc"),
      second = reporter("rpc");
    for (const r of [first, second]) {
      await r.emit("session_start");
      await r.emit("session_shutdown", {
        reason: "resume",
        targetSessionFile: target.path,
      });
    }
    const replacement = reporter("rpc");
    replacement.setSession(target);
    await replacement.emit("session_start", {
      reason: "resume",
      previousSessionFile: original.path,
    });
    expect(await replacement.storedRecords()).toHaveLength(3);
    await expect(
      new PiSessionOccupancy().assertWritable(original.id, original.path),
    ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });
  });

  it("keeps same-file replacement held and releases it only after moving elsewhere", async () => {
    const original = session(),
      next = session("two", join(paths.home, "two.jsonl"));
    await writeFile(original.path, "");
    await writeFile(next.path, "");
    const first = reporter("rpc");
    await first.emit("session_start");
    await first.emit("session_shutdown", {
      reason: "resume",
      targetSessionFile: original.path,
    });
    const resumed = reporter("rpc");
    await resumed.emit("session_start", {
      reason: "resume",
      previousSessionFile: original.path,
    });
    expect(await resumed.storedRecords()).toHaveLength(1);
    const guard = new PiSessionOccupancy();
    await expect(
      guard.assertWritable(original.id, original.path),
    ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });
    await resumed.emit("session_shutdown", {
      reason: "resume",
      targetSessionFile: next.path,
    });
    const replacement = reporter("rpc");
    replacement.setSession(next);
    await replacement.emit("session_start", {
      reason: "resume",
      previousSessionFile: original.path,
    });
    expect(await replacement.storedRecords()).toHaveLength(1);
    await expect(
      guard.assertWritable(original.id, original.path),
    ).resolves.toBeUndefined();
  });

  it("heartbeats and replaces session identity across TUI and RPC modes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const { emit, records, setSession, context } = reporter();
    await emit("session_start");
    const first = (await records())[0]!;
    const publishes = vi.mocked(rename);
    expect(publishes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ACTIVITY_HEARTBEAT_MS);
    // Fake-clock advancement does not settle real I/O. Await the atomic publish
    // rather than repeatedly opening its target during Windows replacement.
    await vi.waitFor(() => expect(publishes).toHaveBeenCalledTimes(2));
    await publishes.mock.results[1]!.value;
    expect((await records())[0]!.updatedAt).toBe(
      first.updatedAt + ACTIVITY_HEARTBEAT_MS,
    );
    setSession(session("two", join(paths.home, "two.jsonl")));
    await emit("session_start");
    expect(await records()).toMatchObject([
      { sessionId: "two", activity: "idle" },
    ]);
    expect(await records()).toHaveLength(1);

    context.mode = "rpc";
    await emit("session_start");
    await emit("agent_start");
    expect(await records()).toMatchObject([
      { sessionId: "two", activity: "working" },
    ]);
    expect(await records()).toHaveLength(1);
  });

  it("excludes only the loaded Inspire RPC bridge, not inherited worker environment", async () => {
    vi.stubEnv("INSPIRE_BRANCH_COMMAND", "activity_test_bridge");
    const { emit, records, commands, context } = reporter("rpc");
    commands.mockReturnValue([{ name: "another_command" }]);
    await emit("session_start");
    await emit("agent_start");
    expect(await records()).toMatchObject([{ activity: "working" }]);

    commands.mockReturnValue([{ name: "activity_test_bridge" }]);
    await emit("session_start");
    await emit("agent_start");
    expect(await records()).toEqual([]);

    context.mode = "tui";
    await emit("session_start");
    expect(await records()).toMatchObject([{ activity: "idle" }]);
  });
});
