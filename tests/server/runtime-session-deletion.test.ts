import { access, rm, writeFile } from "node:fs/promises";

import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullDiagnosticLogger } from "../../server/diagnostics.js";
import { type PiRpcProcess } from "../../server/pi-rpc.js";

import { RuntimeController } from "../../server/runtime.js";
import { SessionCatalog } from "../../server/session-catalog.js";

import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  HIDDEN_FOLDER_CWD,
  initializeRuntimeFixture,
  persistedRecord,
  preview,
  record,
  trackedAttachmentStore,
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
    const runtime = new RuntimeController(
      source,
      trackedAttachmentStore(),
      undefined,
      preview,
      15_000,
      undefined,
      remove,
    );
    try {
      expect((await source.list()).sessions).toHaveLength(1);
      await expect(
        runtime.clearHiddenSessions(["a"], ["a"], []),
      ).rejects.toMatchObject({ code: "SESSION_CATALOG_INCOMPLETE" });
      expect(remove).not.toHaveBeenCalled();
      await expect(runtime.deleteSession("a")).resolves.toMatchObject({
        disposition: "trashed",
      });
    } finally {
      await runtime.close();
    }
  });
  it("deletes an unopened catalog session through the injected destructive boundary", async () => {
    const store = trackedAttachmentStore();
    const source = catalog([record("a", "/tmp")]);
    source.refresh = vi.fn(source.refresh);
    source.invalidate = vi.fn();
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      source,
      store,
      undefined,
      preview,
      15_000,
      undefined,
      remove,
    );

    await expect(runtime.deleteSession("a")).resolves.toEqual({
      sessionId: "a",
      disposition: "trashed",
    });
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", path: resolve("/sessions/a.jsonl") }),
      "current",
    );
    expect(source.refresh).not.toHaveBeenCalled();
    expect(source.invalidate).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it.each(["single", "hidden"] as const)(
    "returns committed %s deletion while attachment collection is still pending",
    async (operation) => {
      const store = trackedAttachmentStore();
      const { promise: gate, resolve: release } = deferredSignal();
      const collect = vi
        .spyOn(store, "collectUnreferenced")
        .mockImplementation(async () => {
          await gate;
          return { reclaimed: [], deferred: "Reference source is unavailable" };
        });
      const diagnostics = nullDiagnosticLogger();
      const log = vi.spyOn(diagnostics, "record");
      const sessions = [await persistedRecord("a"), await persistedRecord("b")];
      const remove = vi.fn(async () => "trashed" as const);
      const runtime = new RuntimeController(
        catalog(sessions),
        store,
        undefined,
        preview,
        15_000,
        undefined,
        remove,
        diagnostics,
      );

      try {
        if (operation === "single") {
          await expect(runtime.deleteSession("a")).resolves.toEqual({
            sessionId: "a",
            disposition: "trashed",
          });
        } else {
          await expect(
            runtime.clearHiddenSessions(["a", "b"], ["a", "b"], []),
          ).resolves.toEqual({
            deleted: [
              { sessionId: "a", disposition: "trashed" },
              { sessionId: "b", disposition: "trashed" },
            ],
          });
        }
        const count = operation === "single" ? 1 : 2;
        expect(remove).toHaveBeenCalledTimes(count);
        expect(collect).toHaveBeenCalledTimes(count);
        expect(log).not.toHaveBeenCalled();
        release();
        await vi.waitFor(() =>
          expect(log).toHaveBeenCalledWith(
            "error",
            "attachment_reclamation_deferred",
            expect.objectContaining({ sessionId: "a" }),
          ),
        );
      } finally {
        release();
        await runtime.close();
      }
    },
  );

  it("records rejected background collection without changing deletion success", async () => {
    const store = trackedAttachmentStore();
    vi.spyOn(store, "sessionDeleted").mockRejectedValue(
      new Error("Collection unavailable"),
    );
    const diagnostics = nullDiagnosticLogger();
    const log = vi.spyOn(diagnostics, "record");
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      undefined,
      preview,
      15_000,
      undefined,
      async () => "deleted",
      diagnostics,
    );
    try {
      await expect(runtime.deleteSession("a")).resolves.toEqual({
        sessionId: "a",
        disposition: "deleted",
      });
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          "error",
          "attachment_reclamation_deferred",
          expect.objectContaining({ sessionId: "a" }),
        ),
      );
    } finally {
      await runtime.close();
    }
  });

  it("does not delete a catalog identity reserved by a provisional new session", async () => {
    const store = trackedAttachmentStore();
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      undefined,
      preview,
      15_000,
      undefined,
      remove,
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

  it("clears individually hidden sessions and every session in hidden folders after reserving all identities", async () => {
    const store = trackedAttachmentStore();
    const source = catalog([
      await persistedRecord("a", "/loose"),
      await persistedRecord("b", "/folder"),
      await persistedRecord("c", "/folder"),
      record("ordinary", "/ordinary"),
    ]);
    source.refresh = vi.fn(source.refresh);
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      source,
      store,
      undefined,
      preview,
      15_000,
      undefined,
      remove,
    );

    await expect(
      runtime.clearHiddenSessions(["a", "b", "c"], ["a"], [HIDDEN_FOLDER_CWD]),
    ).resolves.toEqual({
      deleted: [
        { sessionId: "a", disposition: "trashed" },
        { sessionId: "b", disposition: "trashed" },
        { sessionId: "c", disposition: "trashed" },
      ],
    });
    expect(source.refresh).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledTimes(3);
    for (const id of ["a", "b", "c"]) {
      expect(remove).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        "catalog",
      );
    }
    expect(remove).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "ordinary" }),
      expect.anything(),
    );
    await runtime.close();
  });

  it("requires the complete selected folder and leaves other Hidden records untouched", async () => {
    const source = catalog([
      await persistedRecord("loose", "/loose"),
      await persistedRecord("b", "/folder"),
      await persistedRecord("c", "/folder"),
      await persistedRecord("other", "/other"),
    ]);
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      source,
      trackedAttachmentStore(),
      undefined,
      preview,
      15_000,
      undefined,
      remove,
    );
    try {
      await expect(
        runtime.clearHiddenSessions(["b"], [], [HIDDEN_FOLDER_CWD]),
      ).rejects.toMatchObject({ status: 409 });
      expect(remove).not.toHaveBeenCalled();
      await expect(
        runtime.clearHiddenSessions(["b", "c"], [], [HIDDEN_FOLDER_CWD]),
      ).resolves.toMatchObject({
        deleted: [{ sessionId: "b" }, { sessionId: "c" }],
      });
      expect(remove).toHaveBeenCalledTimes(2);
      expect(remove).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: "b" }),
        "catalog",
      );
      expect(remove).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: "c" }),
        "catalog",
      );
    } finally {
      await runtime.close();
    }
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
        undefined,
        undefined,
        undefined,
        undefined,
        remove,
      );
      try {
        await expect(
          runtime.clearHiddenSessions(["a", "b"], ["a", "b"], []),
        ).rejects.toMatchObject({ status: failure === "missing" ? 404 : 409 });
        expect(remove).not.toHaveBeenCalled();
        await expect(access(first.path)).resolves.toBeUndefined();
      } finally {
        await runtime.close();
      }
    },
  );

  it("rejects a Hidden clear if its reviewed session snapshot changed", async () => {
    const store = trackedAttachmentStore();
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/loose"), record("b", "/folder")]),
      store,
      undefined,
      preview,
      15_000,
      undefined,
      remove,
    );

    await expect(
      runtime.clearHiddenSessions(["a"], ["a"], [HIDDEN_FOLDER_CWD]),
    ).rejects.toMatchObject({
      status: 409,
      message: "Hidden changed; review it before clearing",
      code: "HIDDEN_SELECTION_CHANGED",
    });
    expect(remove).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("clears a complete Hidden set containing the selected idle session", async () => {
    const store = trackedAttachmentStore();
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([
        await persistedRecord("a", "/loose"),
        await persistedRecord("b", "/folder"),
      ]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
      15_000,
      undefined,
      remove,
    );
    await runtime.openSession("a");
    await waitForReady(runtime);
    await expect(
      runtime.clearHiddenSessions(["a", "b"], ["a"], [HIDDEN_FOLDER_CWD]),
    ).resolves.toMatchObject({
      deleted: [{ sessionId: "a" }, { sessionId: "b" }],
    });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(runtime.activeSessionId).toBeNull();
    expect((await runtime.snapshot()).active).toBeNull();
    await runtime.close();
  });

  it("rejects a Hidden clear before moving any session with queued input", async () => {
    const store = trackedAttachmentStore();
    const workers = new Map<string, FakeRpc>();
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/hidden"), record("ordinary", "/ordinary")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.set(worker.sessionId, worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
      15_000,
      undefined,
      remove,
    );

    await runtime.openSession("a");
    await waitForReady(runtime);
    const worker = workers.get("a")!;
    worker.emit("event", {
      type: "queue_update",
      steering: ["waiting"],
      followUp: [],
    });
    expect((await runtime.snapshot()).pendingQueues?.totalCount).toBe(1);
    await runtime.openSession("ordinary");

    await expect(
      runtime.clearHiddenSessions(["a"], ["a"], []),
    ).rejects.toMatchObject({ status: 409 });
    expect(remove).not.toHaveBeenCalled();
    expect(worker.stops).toBe(0);
    await runtime.close();
  });

  it("refuses an ambiguous catalog identity before touching either file", async () => {
    const store = trackedAttachmentStore();
    const first = record("a", "/tmp");
    const second = {
      ...record("a", "/other"),
      path: resolve("/sessions/copied-a.jsonl"),
    };
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([first, second]),
      store,
      undefined,
      preview,
      15_000,
      undefined,
      remove,
    );

    await expect(runtime.deleteSession("a")).rejects.toMatchObject({
      message: "The session identity is ambiguous in the Pi catalog",
      status: 409,
    });
    expect(remove).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("retires the selected idle session and clears its selection after deletion commits", async () => {
    const store = trackedAttachmentStore();
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
      15_000,
      undefined,
      remove,
    );

    await runtime.openSession("a");
    await waitForReady(runtime);
    await expect(runtime.deleteSession("a")).resolves.toEqual({
      sessionId: "a",
      disposition: "trashed",
    });
    expect(remove).toHaveBeenCalledOnce();
    expect(runtime.activeSessionId).toBeNull();
    expect((await runtime.snapshot()).active).toBeNull();
    await runtime.close();
  });

  it("preserves the selected session after a filesystem deletion failure", async () => {
    const workers: FakeRpc[] = [];
    const remove = vi.fn(async () => {
      throw new Error("Trash unavailable");
    });
    const runtime = new RuntimeController(
      catalog([await persistedRecord("a")]),
      trackedAttachmentStore(),
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      undefined,
      15_000,
      undefined,
      remove,
    );
    try {
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
    } finally {
      await runtime.close();
    }
  });

  it.each(["settled", "in-flight"] as const)(
    "preserves a newer %s selection when deletion commits",
    async (phase) => {
      const { promise: deleteGate, resolve: releaseDelete } = deferredSignal();
      const { promise: previewGate, resolve: releasePreview } =
        deferredSignal();
      const { promise: started, resolve: deleteStarted } = deferredSignal();
      const runtime = new RuntimeController(
        catalog([record("a", "/tmp"), record("b", "/tmp")]),
        trackedAttachmentStore(),
        (options) => new FakeRpc(options) as unknown as PiRpcProcess,
        async (session) => {
          if (session.id === "b" && phase === "in-flight") await previewGate;
          return preview(session);
        },
        15_000,
        undefined,
        async () => {
          deleteStarted();
          await deleteGate;
          return "trashed";
        },
      );
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

  it("makes the prior idle session deletable after New session deselects host ownership", async () => {
    const store = trackedAttachmentStore();
    const remove = vi.fn(async () => "trashed" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
      15_000,
      undefined,
      remove,
    );

    await runtime.openSession("a");
    const deselected = await runtime.deselectSession();
    expect(deselected.active).toBeNull();
    expect(runtime.activeSessionId).toBeNull();
    await expect(runtime.deleteSession("a")).resolves.toEqual({
      sessionId: "a",
      disposition: "trashed",
    });
    expect(remove).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it.each(["running", "queued"] as const)(
    "refuses to delete an unselected %s session before touching its file or worker",
    async (phase) => {
      const workers = new Map<string, FakeRpc>();
      const remove = vi.fn(async () => "trashed" as const);
      const runtime = new RuntimeController(
        catalog([record("a", "/tmp"), record("b", "/tmp")]),
        trackedAttachmentStore(),
        (options) => {
          const worker = new FakeRpc(options);
          workers.set(worker.sessionId, worker);
          return worker as unknown as PiRpcProcess;
        },
        preview,
        15_000,
        undefined,
        remove,
      );
      try {
        await runtime.openSession("a");
        await waitForReady(runtime);
        const worker = workers.get("a")!;
        worker.emit(
          "event",
          phase === "running"
            ? { type: "agent_start" }
            : { type: "queue_update", steering: ["waiting"], followUp: [] },
        );
        await runtime.openSession("b");
        await expect(runtime.deleteSession("a")).rejects.toMatchObject({
          status: 409,
        });
        expect(remove).not.toHaveBeenCalled();
        expect(worker.stops).toBe(0);
      } finally {
        await runtime.close();
      }
    },
  );

  it("stops and retires an idle unselected worker before deleting its file", async () => {
    const store = trackedAttachmentStore();
    const workers = new Map<string, FakeRpc>();
    const remove = vi.fn(async () => "deleted" as const);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.set(worker.sessionId, worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
      15_000,
      undefined,
      remove,
    );

    await runtime.openSession("a");
    await vi.waitFor(() => expect(workers.get("a")?.starts).toBe(1));
    await runtime.openSession("b");
    await vi.waitFor(() => expect(workers.get("b")?.starts).toBe(1));
    const internal = runtime as unknown as {
      slots: Map<string, { activeOperations: number }>;
    };
    await vi.waitFor(() =>
      expect(internal.slots.get("a")?.activeOperations).toBe(0),
    );

    await expect(runtime.deleteSession("a")).resolves.toEqual({
      sessionId: "a",
      disposition: "deleted",
    });
    expect(workers.get("a")?.stops).toBe(1);
    expect(runtime.sessionCwd("a")).toBeNull();
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      "current",
    );
    await runtime.close();
  });

  it("blocks new opens while a deletion outcome is in flight", async () => {
    const store = trackedAttachmentStore();
    const { promise: gate, resolve: release } = deferredSignal();
    let entered = false;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
      15_000,
      undefined,
      async () => {
        entered = true;
        await gate;
        return "trashed";
      },
    );

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
