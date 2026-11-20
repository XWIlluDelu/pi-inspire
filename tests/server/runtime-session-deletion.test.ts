import { access, appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCatalog } from "../../server/session-catalog.js";
import { deleteSessionFile } from "../../server/session-delete.js";
import { SessionProjection } from "../../server/session-projection.js";
import type { SessionDeletionRequest } from "../../shared/contracts.js";
import {
  deferredSignal,
  disposeRuntimeFixture,
  fakeRuntime,
  fixtureWorkspace,
  HIDDEN_FOLDER_CWD,
  initializeRuntimeFixture,
  persistedRecord,
  startWorker,
  trackRuntime,
} from "./fixtures/runtime.js";
import { jsonl } from "./fixtures/session-jsonl.js";

beforeEach(async () => {
  await initializeRuntimeFixture();
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", fixtureWorkspace);
});
afterEach(disposeRuntimeFixture);

async function fixture({
  catalogFailure,
  ...options
}: Omit<
  NonNullable<Parameters<typeof fakeRuntime>[0]>,
  "sessions" | "source"
> & {
  catalogFailure?: "catalog unavailable" | "missing file" | "changed file";
} = {}) {
  const records = await Promise.all([
    persistedRecord("a", "/loose"),
    persistedRecord("b", "/folder"),
    persistedRecord("c", "/folder"),
    persistedRecord("other", "/other"),
  ]);
  const source = new SessionCatalog(
    fixtureWorkspace,
    catalogFailure
      ? {
          list: async (_directories, unavailablePaths) => {
            if (catalogFailure === "catalog unavailable")
              unavailablePaths!.push("/offline");
            return records;
          },
        }
      : undefined,
  );
  const trash = vi.fn(async (payload: string, _original: string) =>
    rm(payload),
  );
  const f = fakeRuntime({
    source,
    deleteSessionRecord: (session) => deleteSessionFile(session, trash),
    ...options,
  });
  trackRuntime(f.runtime);
  const curation = {
    hiddenSessionIds: ["a"],
    hiddenProjectCwds: [HIDDEN_FOLDER_CWD],
  };
  const remove = (reviewed: SessionDeletionRequest, confirmed = curation) =>
    f.runtime.deleteSessions(reviewed, confirmed);
  return {
    ...f,
    source,
    records,
    trash,
    one: (sessionId = "a") => remove({ scope: "session", sessionId }),
    hidden: (sessionIds = ["a", "b", "c"], onlyFolder = false) =>
      remove(
        { scope: "hidden", sessionIds },
        onlyFolder ? { ...curation, hiddenSessionIds: [] } : curation,
      ),
  };
}

const trashed = (sessionId: string) => ({ sessionId, disposition: "trashed" });
const gone = (path: string) =>
  expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });

describe("runtime session deletion", () => {
  it.each([
    "catalog unavailable",
    "omitted member",
    "missing file",
    "changed file",
  ] as const)(
    "does not stop or move any target with %s at Hidden preflight",
    async (cause) => {
      const stop = vi.fn(async () => {});
      const f = await fixture({
        stopExternalSession: stop,
        catalogFailure: cause === "omitted member" ? undefined : cause,
      });
      await f.source.refresh();
      const [a, , c] = f.records;
      if (cause === "missing file") await rm(c!.path);
      if (cause === "changed file")
        await writeFile(c!.path, "changed after catalog discovery\n");
      const issues = {
        "catalog unavailable": { code: "SESSION_CATALOG_INCOMPLETE" },
        "omitted member": { code: "HIDDEN_SELECTION_CHANGED", status: 409 },
        "missing file": { status: 404 },
        "changed file": { status: 409 },
      };
      await expect(
        f.hidden(
          cause === "omitted member" ? ["b"] : undefined,
          cause === "omitted member",
        ),
      ).rejects.toMatchObject(issues[cause]);
      expect(stop).not.toHaveBeenCalled();
      expect(f.trash).not.toHaveBeenCalled();
      await expect(access(a!.path)).resolves.toBeUndefined();
      if (cause === "catalog unavailable")
        await expect(f.one()).resolves.toEqual({ deleted: [trashed("a")] });
      if (cause === "omitted member") {
        await expect(f.hidden(["b", "c"], true)).resolves.toEqual({
          deleted: [trashed("b"), trashed("c")],
        });
        await expect(access(a!.path)).resolves.toBeUndefined();
      }
    },
  );

  it("refuses an ambiguous identity before touching either native file", async () => {
    const f = await fixture();
    const [a] = f.records;
    const copy = join(fixtureWorkspace, "copied.jsonl");
    await writeFile(copy, await readFile(a!.path));
    await expect(f.one()).rejects.toMatchObject({
      status: 409,
      message: "The session identity is ambiguous in the Pi catalog",
    });
    expect(f.trash).not.toHaveBeenCalled();
    await expect(access(copy)).resolves.toBeUndefined();
    await expect(access(a!.path)).resolves.toBeUndefined();
  });

  it("protects the exact ID while a new native session is becoming ready", async () => {
    const entered = deferredSignal();
    const ready = deferredSignal();
    const f = await fixture({
      configure(worker) {
        worker.sessionId = "a";
        worker.responseOverrides.set("get_session_stats", async () => {
          entered.resolve();
          await ready.promise;
          return {};
        });
      },
    });
    const opening = f.runtime.newSession(fixtureWorkspace);
    try {
      await Promise.race([
        entered.promise,
        opening.then(() => {
          throw new Error("Creation skipped the ready gate");
        }),
      ]);
      await expect(f.one()).rejects.toMatchObject({
        status: 409,
        message: "Wait for the session to finish opening before deleting it",
      });
      expect(f.trash).not.toHaveBeenCalled();
    } finally {
      ready.resolve();
      await opening;
    }
  });

  it.each(["complete", "partial"] as const)(
    "clears the reviewed Hidden union with a %s outcome",
    async (mode) => {
      const finalEntry = "Still the same session";
      const f = await fixture({
        stopExternalSession: async (id, path) => {
          if (id === "a")
            await appendFile(
              path,
              jsonl({
                type: "session_info",
                id: "name",
                parentId: "u1",
                timestamp: new Date().toISOString(),
                name: finalEntry,
              }),
            );
        },
      });
      const [a, b, c, other] = f.records;
      await f.runtime.openSession("a");
      await startWorker(f.runtime);
      const aWorker = f.workers[0]!;
      aWorker.emit("event", {
        type: "queue_update",
        steering: ["waiting"],
        followUp: [],
      });
      expect((await f.runtime.snapshot("a")).pendingQueues?.totalCount).toBe(1);
      await f.runtime.openSession("other");
      await startWorker(f.runtime, "other");
      await f.runtime.openSession("a");
      f.trash.mockImplementation(async (payload, original) => {
        expect(aWorker.stops).toBe(1);
        expect(f.workers[1]!.stops).toBe(0);
        if (original === a!.path)
          expect(await readFile(payload, "utf8")).toContain(finalEntry);
        if (mode !== "partial" || original !== b!.path) await rm(payload);
      });
      const outcome =
        mode === "partial"
          ? {
              deleted: [trashed("a")],
              failure: {
                sessionId: "b",
                message: "The Trash operation did not move the session payload",
              },
            }
          : { deleted: [trashed("a"), trashed("b"), trashed("c")] };
      await expect(f.hidden()).resolves.toEqual(outcome);
      const touched = mode === "partial" ? [a!, b!] : [a!, b!, c!];
      for (const session of touched) await gone(session.path);
      if (mode === "partial") {
        await expect(access(c!.path)).resolves.toBeUndefined();
        await expect(
          access(f.trash.mock.calls[1]![0]),
        ).resolves.toBeUndefined();
      }
      await expect(access(other!.path)).resolves.toBeUndefined();
      expect(f.trash.mock.calls.map(([, original]) => original)).toEqual(
        touched.map(({ path }) => path),
      );
      expect(f.runtime.startupSessionHint).toBeNull();
      expect(f.runtime.sessionCwd("a")).toBeNull();
    },
  );

  it.each(["Pi still alive", "Trash unavailable"] as const)(
    "preserves the selected file and recovers after %s",
    async (failure) => {
      const move = vi.fn(async () => {
        throw new Error("Trash unavailable");
      });
      const f = await fixture({
        deleteSessionRecord: move,
        stopExternalSession: async () => {
          if (failure === "Pi still alive") throw new Error(failure);
        },
      });
      await f.runtime.openSession("a");
      await startWorker(f.runtime);
      await expect(f.one()).rejects.toThrow(failure);
      expect(move).toHaveBeenCalledTimes(failure === "Pi still alive" ? 0 : 1);
      expect(f.workers[0]!.stops).toBe(1);
      await expect(access(f.records[0]!.path)).resolves.toBeUndefined();
      expect(f.runtime.startupSessionHint).toBe("a");
      await f.runtime.openSession("a");
      await startWorker(f.runtime);
      expect(f.workers).toHaveLength(2);
    },
  );

  it.each(["settled", "in-flight"] as const)(
    "keeps a newer %s open when deletion commits",
    async (phase) => {
      const moving = deferredSignal();
      const entered = deferredSignal();
      const opening = deferredSignal();
      let f: Awaited<ReturnType<typeof fixture>>;
      f = await fixture({
        openSessionProjection: async (session) => {
          if (session.id === "b" && phase === "in-flight")
            await opening.promise;
          return SessionProjection.open(session);
        },
        deleteSessionRecord: async (session) => {
          entered.resolve();
          await moving.promise;
          return deleteSessionFile(session, f.trash);
        },
      });
      await f.runtime.openSession("a");
      try {
        const deleting = f.one();
        await entered.promise;
        await expect(f.runtime.openSession("a")).rejects.toMatchObject({
          status: 409,
          message: "That session is being deleted",
        });
        await expect(f.one()).rejects.toMatchObject({
          status: 409,
          message: "A reviewed session is already being deleted",
        });
        const next = f.runtime.openSession("b");
        if (phase === "settled") await next;
        moving.resolve();
        await expect(deleting).resolves.toEqual({ deleted: [trashed("a")] });
        opening.resolve();
        await next;
        expect(f.runtime.startupSessionHint).toBe("b");
      } finally {
        moving.resolve();
        opening.resolve();
      }
    },
  );

  it("ends a waiting worker and rejects its queued mutation before moving the file", async () => {
    const entered = deferredSignal();
    const exit = Promise.withResolvers<never>();
    const f = await fixture({
      configure(worker) {
        worker.responseOverrides.set("set_session_name", () => {
          entered.resolve();
          return exit.promise;
        });
        const stop = worker.stop.bind(worker);
        vi.spyOn(worker, "stop").mockImplementation(async () => {
          exit.reject(new Error("The worker exited"));
          await stop();
        });
      },
    });
    await f.runtime.openSession("a");
    await startWorker(f.runtime);
    const first = expect(f.runtime.rename("a", "in progress")).rejects.toThrow(
      "The worker exited",
    );
    await entered.promise;
    const queued = expect(
      f.runtime.rename("a", "queued"),
    ).rejects.toMatchObject({
      status: 409,
      message: "That session is being deleted",
    });
    try {
      await expect(f.one()).resolves.toEqual({ deleted: [trashed("a")] });
      await Promise.all([first, queued]);
      expect(f.workers).toHaveLength(1);
      expect(f.trash).toHaveBeenCalledOnce();
    } finally {
      exit.reject(new Error("The worker exited"));
    }
  });
});
