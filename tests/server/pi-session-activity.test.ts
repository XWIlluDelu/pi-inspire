import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
import { PiSessionActivity } from "../../server/pi-session-activity.js";
import type { SessionRecord } from "../../server/session-catalog.js";

const paths = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => paths.home,
}));

const observers: PiSessionActivity[] = [];
const reporters: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  paths.home = await mkdtemp(join(tmpdir(), "inspire-pi-activity-"));
  vi.stubEnv("XDG_CACHE_HOME", join(paths.home, "cache"));
  vi.stubEnv("LOCALAPPDATA", join(paths.home, "local"));
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
    searchText: "Task",
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

function reporter() {
  type Handler = (
    event: Record<string, unknown>,
    ctx: ExtensionContext,
  ) => unknown;
  const handlers = new Map<string, Handler>();
  const idle = vi.fn(() => true);
  let identity = session();
  const context = {
    mode: "tui",
    cwd: paths.home,
    isIdle: idle,
    sessionManager: {
      getSessionId: () => identity.id,
      getSessionFile: () => identity.path,
    },
  } as unknown as ExtensionContext;
  reportActivity({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI);
  const emit = async (type: string) => {
    await handlers.get(type)?.({ type }, context);
  };
  reporters.push(() => emit("session_shutdown"));
  const records = async (): Promise<PiActivityRecord[]> => {
    const names = await readdir(piActivityDirectory()).catch(() => []);
    return Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) =>
          JSON.parse(await readFile(join(piActivityDirectory(), name), "utf8")),
        ),
    );
  };
  return {
    emit,
    idle,
    context,
    records,
    setSession: (next: SessionRecord) => {
      identity = next;
    },
  };
}

describe("optional native Pi activity reporter", () => {
  it("reports startup, work, input waiting and final settlement without ending at agent_end", async () => {
    const { emit, idle, records } = reporter();
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
  });

  it("heartbeats and replaces session identity, and leaves RPC workers to Inspire", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const { emit, records, setSession, context } = reporter();
    await emit("session_start");
    const first = (await records())[0]!;
    await vi.advanceTimersByTimeAsync(ACTIVITY_HEARTBEAT_MS);
    await vi.waitFor(async () => {
      expect((await records())[0]!.updatedAt).toBeGreaterThan(first.updatedAt);
    });
    setSession(session("two", join(paths.home, "two.jsonl")));
    await emit("session_start");
    expect(await records()).toMatchObject([
      { sessionId: "two", activity: "idle" },
    ]);
    expect(await records()).toHaveLength(1);

    context.mode = "rpc";
    await emit("session_start");
    await emit("agent_start");
    expect(await records()).toEqual([]);
  });
});
