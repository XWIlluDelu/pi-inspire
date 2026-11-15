import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalHistoryStore } from "../../server/terminal-history-store.js";
import type { TerminalPersistedState } from "../../server/terminal-session-manager.js";
import {
  readTerminalState,
  TerminalStateWriter,
} from "../../server/terminal-state-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "inspire-terminal-history-"));
  directories.push(root);
  const directory = join(root, "history");
  return { root, directory, store: new TerminalHistoryStore(directory) };
}

describe("TerminalHistoryStore", () => {
  it("batches private output and clears it", async () => {
    const { directory, store } = await setup();
    store.append("terminal-1", Buffer.from("one"));
    store.append("terminal-1", Buffer.from(" two"));
    await store.flush();

    expect(String(await store.read("terminal-1"))).toBe("one two");
    if (process.platform !== "win32") {
      expect((await lstat(directory)).mode & 0o077).toBe(0);
      expect(
        (await lstat(join(directory, "terminal-1.log"))).mode & 0o077,
      ).toBe(0);
    }

    await store.clear();
    expect(await store.read("terminal-1")).toBeNull();
  });

  it("compacts to a low watermark once and then appends small batches", async () => {
    const { directory, store } = await setup();
    const limit = 32 * 1024 * 1024;
    const retainedBytes = 24 * 1024 * 1024;
    const file = join(directory, "terminal-1.log");
    store.append("terminal-1", Buffer.alloc(limit, 0x41));
    await store.flush();
    expect((await lstat(file)).size).toBe(limit);

    store.append("terminal-1", Buffer.from("first"));
    await store.flush();
    expect((await lstat(file)).size).toBe(retainedBytes);
    for (let index = 0; index < 5; index += 1) {
      store.append("terminal-1", Buffer.from("tail"));
      await store.flush();
      expect((await lstat(file)).size).toBe(retainedBytes + (index + 1) * 4);
    }
    const history = (await store.read("terminal-1"))!;
    expect(history.subarray(0, 2).toString()).toBe("\u001bc");
    expect(history.subarray(2, -25).every((byte) => byte === 0x41)).toBe(true);
    expect(history.subarray(-25).toString()).toBe("first" + "tail".repeat(5));
  });

  it("coalesces output received during a slow disk write without reordering bytes", async () => {
    const { directory, store } = await setup();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let release!: () => void;
    let opened!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      opened = resolve;
    });
    vi.mocked(open)
      .mockClear()
      .mockImplementationOnce(async (...args) => {
        opened();
        await blocked;
        return actual.open(...args);
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    store.append("terminal-1", Buffer.from("first"));
    const firstFlush = store.flush();
    try {
      await writing;
      const chunks = Array.from({ length: 12 }, (_, index) =>
        Buffer.alloc(64 * 1024, 0x41 + index),
      );
      for (const chunk of chunks) {
        store.append("terminal-1", chunk);
        vi.advanceTimersByTime(100);
      }
      expect(open).toHaveBeenCalledTimes(1);
      release();
      await firstFlush;
      await store.flush();

      const received = await readFile(join(directory, "terminal-1.log"));
      expect(
        received.equals(Buffer.concat([Buffer.from("first"), ...chunks])),
      ).toBe(true);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await store.flush();
      vi.useRealTimers();
      vi.mocked(open).mockReset().mockImplementation(actual.open);
    }
  });

  it("prunes output older than the configured retention", async () => {
    const { directory, store } = await setup();
    store.append("terminal-old", Buffer.from("old"));
    store.append("terminal-new", Buffer.from("new"));
    await store.flush();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
    await utimes(join(directory, "terminal-old.log"), old, old);

    await store.prune(5);

    expect(await store.read("terminal-old")).toBeNull();
    expect(String(await store.read("terminal-new"))).toBe("new");
  });

  it.runIf(process.platform !== "win32")(
    "does not follow a substituted history symlink",
    async () => {
      const { directory, store } = await setup();
      await store.append("warmup", Buffer.from("ok"));
      await store.flush();
      const target = join(directory, "target");
      await chmod(directory, 0o700);
      await symlink(target, join(directory, "terminal-link.log"));

      await expect(store.read("terminal-link")).rejects.toThrow(/invalid/u);
    },
  );
});

describe("terminal metadata persistence", () => {
  const state: TerminalPersistedState = {
    version: 1,
    settings: { persistOutput: false, historyRetentionDays: 30 },
    terminals: [],
    orderByProject: [],
  };

  it("publishes scheduled state on flush", async () => {
    const { root } = await setup();
    const path = join(root, "state.json");
    const writer = new TerminalStateWriter(path, () => state);
    writer.schedule();
    await writer.flush();
    expect(await readTerminalState(path)).toEqual(state);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a shared state parent without changing its permissions",
    async () => {
      const { root } = await setup();
      await chmod(root, 0o755);
      const failed = vi.fn();
      const writer = new TerminalStateWriter(
        join(root, "state.json"),
        () => state,
        failed,
      );
      writer.schedule();
      await writer.flush();
      expect(failed).toHaveBeenCalledWith(expect.any(Error));
      expect((await lstat(root)).mode & 0o777).toBe(0o755);
      expect(await readdir(root)).toEqual([]);
    },
  );
});
