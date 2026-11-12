import { access, appendFile, rm, writeFile } from "node:fs/promises";

import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PiRpcProcess } from "../../server/pi-rpc.js";

import { RuntimeController } from "../../server/runtime.js";
import { SessionCatalog } from "../../server/session-catalog.js";

import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  fakeRuntime,
  HIDDEN_FOLDER_CWD,
  initializeRuntimeFixture,
  persistedRecord,
  preview,
  record,
  schedulingRuntime,
  trackedAttachmentStore,
  trackRuntime,
  waitForReady,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("runtime session deletion", () => {
  it("requires a complete catalog for Hidden clearing, not for a specific validated deletion", async () => {
    const session = await persistedRecord("a");
    const source = new SessionCatalog(session.cwd, {
      list: async (_directories, issues) => {
        issues!.push({ path: "/offline", message: "Storage unavailable" });
        return [session];
      },
    });
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(source, trackedAttachmentStore(), {
      openSessionProjection: preview,
      branchBridgeTimeoutMs: 15_000,
      deleteSessionRecord: remove,
    });
    trackRuntime(runtime);
    expect((await source.list()).sessions).toHaveLength(1);
    await expect(
      runtime.clearHiddenSessions(["a"], ["a"], []),
    ).rejects.toMatchObject({ code: "SESSION_CATALOG_INCOMPLETE" });
    expect(remove).not.toHaveBeenCalled();
    await expect(runtime.deleteSession("a")).resolves.toMatchObject({
      disposition: "trashed",
    });
  });
  it("leaves a session file in place when an external instance cannot be ended", async () => {
    const session = await persistedRecord("a");
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        openSessionProjection: preview,
        branchBridgeTimeoutMs: 15_000,
        deleteSessionRecord: remove,
      },
    ).setExternalSessionTerminator(async () => {
      throw new Error("Pi has not exited");
    });
    trackRuntime(runtime);
    await expect(runtime.deleteSession("a")).rejects.toThrow(
      "Pi has not exited",
    );
    expect(remove).not.toHaveBeenCalled();
    await expect(access(session.path)).resolves.toBeUndefined();
  });

  it("does not delete a catalog identity reserved by a provisional new session", async () => {
    const store = trackedAttachmentStore();
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      {
        openSessionProjection: preview,
        branchBridgeTimeoutMs: 15_000,
        deleteSessionRecord: remove,
      },
    );
    const provisionalSlots = (
      runtime as unknown as {
        provisionalSlots: Map<
          string,
          {
            slot: { id: string; sessionPath: string | null };
            completion: Promise<void>;
          }
        >;
      }
    ).provisionalSlots;
    provisionalSlots.set("pending-test", {
      slot: { id: "a", sessionPath: null },
      completion: new Promise(() => undefined),
    });
    try {
      await expect(runtime.deleteSession("a")).rejects.toMatchObject({
        status: 409,
        message: "Wait for the session to finish opening before deleting it",
      });
      expect(remove).not.toHaveBeenCalled();
    } finally {
      provisionalSlots.delete("pending-test");
      await runtime.close();
    }
  });

  it("clears the complete Hidden union, including the selected session, and preserves other sessions", async () => {
    const source = catalog([
      await persistedRecord("a", "/loose"),
      await persistedRecord("b", "/folder"),
      await persistedRecord("c", "/folder"),
      record("ordinary", "/ordinary"),
    ]);
    const remove = vi.fn(async () => "trashed" as const);
    const { runtime } = schedulingRuntime({
      source: source,
      deleteSessionRecord: remove,
    });

    trackRuntime(runtime);
    await runtime.openSession("a");
    await waitForReady(runtime);
    await expect(
      runtime.clearHiddenSessions(["a", "b", "c"], ["a"], [HIDDEN_FOLDER_CWD]),
    ).resolves.toEqual({
      deleted: ["a", "b", "c"].map((sessionId) => ({
        sessionId,
        disposition: "trashed",
      })),
    });
    expect(remove.mock.calls).toEqual(
      ["a", "b", "c"].map((id) => [expect.objectContaining({ id })]),
    );
    expect((await runtime.snapshot()).active).toBeNull();
  });

  it("requires the complete selected folder and leaves other Hidden records untouched", async () => {
    const source = catalog([
      await persistedRecord("loose", "/loose"),
      await persistedRecord("b", "/folder"),
      await persistedRecord("c", "/folder"),
      await persistedRecord("other", "/other"),
    ]);
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(source, trackedAttachmentStore(), {
      openSessionProjection: preview,
      branchBridgeTimeoutMs: 15_000,
      deleteSessionRecord: remove,
    });
    trackRuntime(runtime);
    await expect(
      runtime.clearHiddenSessions(["b"], [], [HIDDEN_FOLDER_CWD]),
    ).rejects.toMatchObject({
      status: 409,
      code: "HIDDEN_SELECTION_CHANGED",
    });
    expect(remove).not.toHaveBeenCalled();
    await expect(
      runtime.clearHiddenSessions(["b", "c"], [], [HIDDEN_FOLDER_CWD]),
    ).resolves.toMatchObject({
      deleted: [{ sessionId: "b" }, { sessionId: "c" }],
    });
    expect(remove.mock.calls).toEqual(
      ["b", "c"].map((id) => [expect.objectContaining({ id })]),
    );
  });

  it.each(["missing", "changed"])(
    "retains real Hidden preflight with an injected delete adapter (%s file)",
    async (failure) => {
      const first = await persistedRecord("a");
      const second = await persistedRecord("b");
      if (failure === "missing") await rm(second.path);
      else await writeFile(second.path, "changed after catalog observation\n");
      const remove = vi.fn(async () => "trashed" as const);
      const runtime = new RuntimeController(
        catalog([first, second]),
        trackedAttachmentStore(),
        { deleteSessionRecord: remove },
      );
      trackRuntime(runtime);
      await expect(
        runtime.clearHiddenSessions(["a", "b"], ["a", "b"], []),
      ).rejects.toMatchObject({ status: failure === "missing" ? 404 : 409 });
      expect(remove).not.toHaveBeenCalled();
      await expect(access(first.path)).resolves.toBeUndefined();
    },
  );

  it("accepts ordinary appends between Hidden catalog discovery and instance shutdown", async () => {
    const session = await persistedRecord("a");
    await appendFile(
      session.path,
      JSON.stringify({
        type: "session_info",
        id: "new-name",
        parentId: "u1",
        timestamp: new Date().toISOString(),
        name: "Still the same session",
      }) + "\n",
    );
    const remove = vi.fn(async () => "trashed" as const);
    const stop = vi.fn(async () => {});
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      { deleteSessionRecord: remove },
    ).setExternalSessionTerminator(stop);
    trackRuntime(runtime);
    await expect(
      runtime.clearHiddenSessions(["a"], ["a"], []),
    ).resolves.toMatchObject({
      deleted: [{ sessionId: "a" }],
    });
    expect(stop).toHaveBeenCalledWith("a", session.path);
    expect(remove).toHaveBeenCalledWith(session);
  });

  it("refuses an ambiguous catalog identity before touching either file", async () => {
    const store = trackedAttachmentStore();
    const first = record("a", "/tmp");
    const second = {
      ...record("a", "/other"),
      path: resolve("/sessions/copied-a.jsonl"),
    };
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(catalog([first, second]), store, {
      openSessionProjection: preview,
      branchBridgeTimeoutMs: 15_000,
      deleteSessionRecord: remove,
    });

    await expect(runtime.deleteSession("a")).rejects.toMatchObject({
      message: "The session identity is ambiguous in the Pi catalog",
      status: 409,
    });
    expect(remove).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("preserves the selected session after a filesystem deletion failure", async () => {
    const remove = vi.fn(async () => {
      throw new Error("Trash unavailable");
    });
    const { runtime, workers } = fakeRuntime({
      sessions: [await persistedRecord("a")],
      branchBridgeTimeoutMs: 15_000,
      deleteSessionRecord: remove,
    });
    trackRuntime(runtime);
    await runtime.openSession("a");
    await waitForReady(runtime);
    await expect(runtime.deleteSession("a")).rejects.toThrow(
      "Trash unavailable",
    );
    expect(workers[0]!.stops).toBe(1);
    expect(runtime.activeSessionId).toBe("a");
    expect((await runtime.snapshot()).active?.sessionId).toBe("a");
    await runtime.openSession("a");
    await waitForReady(runtime);
    expect(workers).toHaveLength(2);
  });

  it.each(["settled", "in-flight"] as const)(
    "preserves a newer %s selection when deletion commits",
    async (phase) => {
      const { promise: deleteGate, resolve: releaseDelete } = deferredSignal();
      const { promise: previewGate, resolve: releasePreview } =
        deferredSignal();
      const { promise: started, resolve: deleteStarted } = deferredSignal();
      const { runtime } = fakeRuntime({
        sessions: [record("a", "/tmp"), record("b", "/tmp")],
        openSessionProjection: async (session) => {
          if (session.id === "b" && phase === "in-flight") await previewGate;
          return preview(session);
        },
        branchBridgeTimeoutMs: 15_000,
        deleteSessionRecord: async () => {
          deleteStarted();
          await deleteGate;
          return "trashed";
        },
      });
      try {
        await runtime.openSession("a");
        await waitForReady(runtime);
        const deleting = runtime.deleteSession("a");
        await started;
        const opening = runtime.openSession("b");
        if (phase === "settled") await opening;
        releaseDelete();
        await deleting;
        releasePreview();
        await opening;
        expect(runtime.activeSessionId).toBe("b");
        expect((await runtime.snapshot()).active?.sessionId).toBe("b");
      } finally {
        releaseDelete();
        releasePreview();
        await runtime.close();
      }
    },
  );

  it.each([
    { method: "delete", activity: "idle" },
    { method: "delete", activity: "running" },
    { method: "clear", activity: "queued" },
  ] as const)(
    "ends only the affected $activity Pi before $method commits",
    async ({ method, activity }) => {
      const workers = new Map<string, FakeRpc>();
      const target = await persistedRecord("a");
      const remove = vi.fn(async () => {
        expect(workers.get("a")?.stops).toBe(1);
        expect(workers.get("b")?.stops).toBe(0);
        return "trashed" as const;
      });
      const runtime = new RuntimeController(
        catalog([target, record("b", "/tmp")]),
        trackedAttachmentStore(),
        {
          createProcess: (options) => {
            const worker = new FakeRpc(options);
            workers.set(worker.sessionId, worker);
            return worker as unknown as PiRpcProcess;
          },
          openSessionProjection: preview,
          deleteSessionRecord: remove,
        },
      );
      trackRuntime(runtime);
      await runtime.openSession("a");
      await waitForReady(runtime);
      const worker = workers.get("a")!;
      if (activity === "running") worker.emit("event", { type: "agent_start" });
      if (activity === "queued") {
        worker.emit("event", {
          type: "queue_update",
          steering: ["waiting"],
          followUp: [],
        });
        expect((await runtime.snapshot()).pendingQueues?.totalCount).toBe(1);
      }
      await runtime.openSession("b");
      await waitForReady(runtime, "b");

      const outcome = { sessionId: "a", disposition: "trashed" };
      if (method === "clear")
        await expect(
          runtime.clearHiddenSessions(["a"], ["a"], []),
        ).resolves.toEqual({ deleted: [outcome] });
      else await expect(runtime.deleteSession("a")).resolves.toEqual(outcome);
      expect(remove).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "a", path: target.path }),
      );
      expect(runtime.sessionCwd("a")).toBeNull();
      expect((await runtime.snapshot()).active?.sessionId).toBe("b");
    },
  );

  it("rejects queued mutations after deletion starts instead of respawning Pi", async () => {
    const session = await persistedRecord("a");
    const entered = deferredSignal();
    const held = deferredSignal();
    const remove = vi.fn(async () => "trashed" as const);
    const { runtime, workers } = fakeRuntime({
      sessions: [session],
      deleteSessionRecord: remove,
    });
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      const worker = workers[0]!;
      const request = worker.request.bind(worker);
      vi.spyOn(worker, "request").mockImplementation(
        async (command, ...args) => {
          if (command.type === "set_session_name") {
            entered.resolve();
            await held.promise;
            throw new Error("The worker exited");
          }
          return request(command, ...args);
        },
      );
      const stop = worker.stop.bind(worker);
      vi.spyOn(worker, "stop").mockImplementation(async () => {
        held.resolve();
        await stop();
      });
      const first = runtime.rename("a", "in progress").catch((error) => error);
      await entered.promise;
      const queued = runtime.rename("a", "queued").catch((error) => error);
      await runtime.deleteSession("a");
      expect(await first).toBeInstanceOf(Error);
      expect(await queued).toMatchObject({
        status: 409,
        message: "That session is being deleted",
      });
      expect(workers).toHaveLength(1);
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      held.resolve();
      await runtime.close();
    }
  });

  it("blocks new opens while a deletion outcome is in flight", async () => {
    const { promise: gate, resolve: release } = deferredSignal();
    let entered = false;
    const { runtime } = schedulingRuntime({
      branchBridgeTimeoutMs: 15_000,
      deleteSessionRecord: async () => {
        entered = true;
        await gate;
        return "trashed";
      },
    });

    const deleting = runtime.deleteSession("a");
    await vi.waitFor(() => expect(entered).toBe(true));
    await expect(runtime.openSession("a")).rejects.toMatchObject({
      message: "That session is being deleted",
      status: 409,
    });
    release();
    await expect(deleting).resolves.toEqual({
      sessionId: "a",
      disposition: "trashed",
    });
    await runtime.close();
  });
});
