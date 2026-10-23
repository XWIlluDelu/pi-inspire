import { appendFile, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullDiagnosticLogger } from "../../server/diagnostics.js";
import type {
  ExternalSessionConnection,
  ExternalSessionState,
} from "../../server/external-session.js";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import { RuntimeExternalSessions } from "../../server/runtime-external-sessions.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import { createRuntimeSlot } from "../../server/runtime-slot.js";
import { SessionProjection } from "../../server/session-projection.js";
import { parseAttachmentContext } from "../../shared/attachment-context.js";
import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  initializeRuntimeFixture,
  persistedRecord,
  preview,
  record,
  trackedAttachmentStore,
  waitForReady,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

function nativeFixture() {
  let state: ExternalSessionState | null = { status: "idle" };
  const native: ExternalSessionConnection = {
    read: vi.fn(async () => state),
    prompt: vi.fn(async () => {
      state = { status: "working" };
    }),
    rename: vi.fn(async (_name, beforeSend) => {
      beforeSend?.();
    }),
    abort: vi.fn(async () => {
      state = { status: "idle" };
    }),
    close: vi.fn(),
  };
  return {
    native,
    setState: (next: ExternalSessionState | null) => {
      state = next;
    },
  };
}

describe("continue an externally owned Pi", () => {
  it("observes short native run outcomes without replaying the initial report or claiming idle means success", async () => {
    const f = nativeFixture();
    const old = {
      id: "old",
      outcome: "completed" as const,
      settledAt: Date.now(),
    };
    const runs = { receiverId: "receiver", activeRunId: null, settled: [old] };
    f.setState({ status: "idle", taskRuns: runs });
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      () => {
        throw new Error("must not launch Pi");
      },
      preview,
    ).setExternalSessionConnector(async () => f.native);
    const events: Record<string, unknown>[] = [];
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );
    try {
      await runtime.openSession("a");
      expect(
        events.filter((event) => event.type === "native_task_outcome"),
      ).toEqual([]);
      const failed = {
        id: "new",
        outcome: "failed" as const,
        settledAt: Date.now(),
      };
      f.setState({
        status: "idle",
        taskRuns: { ...runs, settled: [old, failed] },
      });
      await vi.waitFor(
        () =>
          expect(
            events.filter((event) => event.type === "native_task_outcome"),
          ).toEqual([
            expect.objectContaining({
              outcome: "failed",
              outcomeId: "receiver:new",
            }),
          ]),
        { timeout: 2_000 },
      );
      expect((await runtime.snapshot("a")).sessionStatuses.a?.runState).toBe(
        "failed",
      );
    } finally {
      await runtime.close();
    }
  });

  it("checks external ownership for a cold settings mutation without selection warmup", async () => {
    const f = nativeFixture();
    const create = vi.fn(() => {
      throw new Error("must not launch Pi");
    });
    const connect = vi.fn(async () => f.native);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      create,
      preview,
    ).setExternalSessionConnector(connect);
    try {
      await runtime.snapshot("a");
      expect(connect).not.toHaveBeenCalled();
      await expect(runtime.setModel("a", "test", "model")).rejects.toThrow(
        "Inspire session bridge extension",
      );
      expect(connect).toHaveBeenCalledOnce();
      expect(create).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("keeps an unavailable discovered owner read-only and recovers its connection without navigation", async () => {
    const f = nativeFixture();
    const create = vi.fn(() => {
      throw new Error("must not launch Pi");
    });
    vi.mocked(f.native.read).mockRejectedValue(
      new Error("Control endpoint unavailable"),
    );
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      create,
      preview,
    ).setExternalSessionConnector(async () => f.native);
    try {
      await runtime.openSession("a");
      await vi.waitFor(async () =>
        expect((await runtime.snapshot("a")).active?.readOnlyReason).toBe(
          "external-unavailable",
        ),
      );
      await expect(runtime.setThinkingLevel("a", "high")).rejects.toMatchObject(
        { status: 409 },
      );
      expect(create).not.toHaveBeenCalled();
      vi.mocked(f.native.read).mockResolvedValue({ status: "idle" });
      await vi.waitFor(
        async () =>
          expect(
            (await runtime.snapshot("a")).active?.readOnlyReason,
          ).toBeUndefined(),
        { timeout: 2_000 },
      );
      await runtime.prompt({ sessionId: "a", message: "Recovered input" });
      expect(
        (await runtime.snapshot("a")).active?.readOnlyReason,
      ).toBeUndefined();
      expect(f.native.close).not.toHaveBeenCalled();
      expect(f.native.prompt).toHaveBeenCalledOnce();
      expect(create).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("opens, prompts, stops and renames the existing Pi without starting a worker", async () => {
    const f = nativeFixture();
    const create = vi.fn(
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
    );
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      create,
      preview,
    ).setExternalSessionConnector(async () => f.native);
    try {
      await runtime.openSession("a");
      await runtime.prompt({ sessionId: "a", message: "Continue here" });
      expect(f.native.prompt).toHaveBeenCalledWith(
        "Continue here",
        undefined,
        expect.any(Function),
        undefined,
      );
      expect(create).not.toHaveBeenCalled();
      await vi.waitFor(
        async () =>
          expect((await runtime.snapshot("a")).runState).toBe("running"),
        { timeout: 2000 },
      );
      await runtime.abort("a");
      expect(f.native.abort).toHaveBeenCalledOnce();
      await runtime.rename("a", "Understanding");
      expect(f.native.rename).toHaveBeenLastCalledWith(
        "Understanding",
        expect.any(Function),
      );
    } finally {
      await runtime.close();
    }
    expect(f.native.close).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("discards late native state after retirement and completes writer recovery", async () => {
    const f = nativeFixture();
    const entered = deferredSignal();
    const proceed = deferredSignal();
    let retired = false;
    const worker = vi.fn(
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
    );
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      worker,
      preview,
    ).setExternalSessionConnector(async () => (retired ? null : f.native));
    const events: Array<{ type: string }> = [];
    runtime.on("event", (event) => events.push(event));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      runtime.retainSessionView("a");
      await runtime.openSession("a");
      await vi.waitFor(async () =>
        expect((await runtime.snapshot("a")).sessionStatuses.a?.external).toBe(
          true,
        ),
      );
      vi.mocked(f.native.read).mockImplementationOnce(async () => {
        entered.resolve();
        await proceed.promise;
        return { status: "working" };
      });
      await runtime.openSession("a");
      await entered.promise;
      retired = true;
      f.setState(null);
      await vi.advanceTimersByTimeAsync(750);
      expect(f.native.close).toHaveBeenCalledOnce();
      expect(worker).not.toHaveBeenCalled();

      proceed.resolve();
      await waitForReady(runtime, "a");
      expect(worker).toHaveBeenCalledOnce();
      const snapshot = await runtime.snapshot("a");
      expect(snapshot.active?.readOnlyReason).toBeUndefined();
      expect(snapshot.sessionStatuses.a?.external).not.toBe(true);
      expect(snapshot.runState).toBe("idle");
      expect(events.some((event) => event.type === "agent_start")).toBe(false);
    } finally {
      proceed.resolve();
      await runtime.close();
      vi.useRealTimers();
    }
  });

  it("does not block Host restart for independently running Pi work", async () => {
    const f = nativeFixture();
    f.setState({ status: "working" });
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      () => {
        throw new Error("must not launch Pi");
      },
      preview,
    ).setExternalSessionConnector(async () => f.native);
    try {
      await runtime.openSession("a");
      await vi.waitFor(async () =>
        expect((await runtime.snapshot()).runState).toBe("running"),
      );
      expect(runtime.reserveMaintenanceRestart()).toMatchObject({
        kind: "ready",
      });
    } finally {
      await runtime.close();
    }
    expect(f.native.abort).not.toHaveBeenCalled();
    expect(f.native.close).toHaveBeenCalledOnce();
  });

  it("keeps simultaneous warmup and prompt on one connection and retains addressed selection", async () => {
    const f = nativeFixture();
    const gate = deferredSignal();
    const connect = vi.fn(async (id: string) => {
      if (id === "a") {
        await gate.promise;
        return f.native;
      }
      return null;
    });
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    ).setExternalSessionConnector(connect);
    try {
      await runtime.openSession("a");
      const sending = runtime.prompt({ sessionId: "a", message: "For A only" });
      await runtime.openSession("b");
      gate.resolve();
      await sending;
      expect(connect.mock.calls.filter(([id]) => id === "a")).toHaveLength(1);
      expect(runtime.activeSessionId).toBe("b");
      expect(workers.every((worker) => worker.sessionId === "b")).toBe(true);
      expect(f.native.prompt).toHaveBeenCalledWith(
        "For A only",
        undefined,
        expect.any(Function),
        undefined,
      );
    } finally {
      gate.resolve();
      await runtime.close();
    }
  });

  it("displays native history appends without claiming another writer or losing the connection", async () => {
    const session = await persistedRecord("a");
    const f = nativeFixture();
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      () => {
        throw new Error("must not launch Pi");
      },
    ).setExternalSessionConnector(async () => f.native);
    try {
      await runtime.openSession("a");
      await runtime.prompt({ sessionId: "a", message: "Continue" });
      const entries = (await readFile(session.path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      await appendFile(
        session.path,
        JSON.stringify({
          type: "message",
          id: "native-reply",
          parentId: entries.at(-1).id,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Reply from the same Pi" }],
            timestamp: Date.now(),
          },
        }) + "\n",
      );
      const snapshot = await runtime.snapshot("a");
      expect(snapshot.active?.projectionConflict).toBeNull();
      expect(
        JSON.stringify(snapshot.active?.transcriptPage.messages),
      ).toContain("Reply from the same Pi");
      expect(f.native.close).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("passes files through native input and retains their bytes for the existing process", async () => {
    const store = trackedAttachmentStore();
    const uploaded = await store.add({
      originalname: "notes.txt",
      mimetype: "text/plain",
      size: 5,
      buffer: Buffer.from("notes"),
    } as Express.Multer.File);
    const f = nativeFixture();
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      () => {
        throw new Error("must not launch Pi");
      },
      preview,
    ).setExternalSessionConnector(async () => f.native);
    try {
      await runtime.openSession("a");
      await runtime.prompt({
        sessionId: "a",
        message: "Read this",
        attachmentIds: [uploaded.id],
      });
      const text = vi.mocked(f.native.prompt).mock.calls[0]![0];
      expect(text).toContain("Read this");
      expect(text).toContain("Referenced files available");
      const paths = parseAttachmentContext(text).references;
      expect(paths).toHaveLength(1);
      expect(await readFile(paths[0]!, "utf8")).toBe("notes");
    } finally {
      await runtime.close();
    }
  });

  it("leases real image references, restores rejected staging, and releases consumed images", async () => {
    const f = nativeFixture(),
      store = trackedAttachmentStore();
    const uploaded = await store.add({
      originalname: "image.png",
      mimetype: "image/png",
      size: 6,
      buffer: Buffer.from("pixels"),
    } as Express.Multer.File);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      () => {
        throw new Error("must not launch Pi");
      },
      preview,
    ).setExternalSessionConnector(async () => f.native);
    vi.mocked(f.native.prompt).mockImplementationOnce(
      async (_text, _behavior, _beforeSend, images) => {
        expect(images).toHaveLength(1);
        expect(await readFile(images![0]!.path, "utf8")).toBe("pixels");
        throw new Error("Native question is waiting");
      },
    );
    try {
      await runtime.openSession("a");
      const request = {
        sessionId: "a",
        message: "",
        attachmentIds: [uploaded.id],
      };
      await expect(runtime.prompt(request)).rejects.toThrow("Native question");
      expect((await store.imagePreview(uploaded.id)).bytes.toString()).toBe(
        "pixels",
      );
      await runtime.prompt(request);
      expect(vi.mocked(f.native.prompt).mock.lastCall?.[0]).toBe("");
      expect(vi.mocked(f.native.prompt).mock.lastCall?.[3]).toEqual([
        expect.objectContaining({ mimeType: "image/png" }),
      ]);
      await expect(store.imagePreview(uploaded.id)).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      await runtime.close();
    }
  });

  it("does not deliver a prepared message after Stop and admits a genuinely new send", async () => {
    const f = nativeFixture();
    const entered = deferredSignal();
    const gate = deferredSignal();
    const delivered: string[] = [];
    vi.mocked(f.native.prompt)
      .mockImplementationOnce(async (text, _behavior, beforeSend) => {
        entered.resolve();
        await gate.promise;
        beforeSend?.();
        delivered.push(text);
      })
      .mockImplementation(async (text, _behavior, beforeSend) => {
        beforeSend?.();
        delivered.push(text);
      });
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      () => {
        throw new Error("must not launch Pi");
      },
      preview,
    ).setExternalSessionConnector(async () => f.native);
    try {
      await runtime.openSession("a");
      const sending = runtime
        .prompt({ sessionId: "a", message: "Stopped input" })
        .catch((error) => error);
      await entered.promise;
      await runtime.abort("a");
      gate.resolve();
      expect(await sending).toMatchObject({ status: 409 });
      expect(delivered).toEqual([]);
      await runtime.prompt({ sessionId: "a", message: "Fresh input" });
      expect(delivered).toEqual(["Fresh input"]);
    } finally {
      gate.resolve();
      await runtime.close();
    }
  });

  it("observes native status without rebuilding reclaimed background history or logging missing projections", async () => {
    const f = nativeFixture();
    f.setState({ status: "working" });
    const diagnostics = nullDiagnosticLogger();
    const log = vi.spyOn(diagnostics, "record");
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      trackedAttachmentStore(),
      () => {
        throw new Error("must not launch Pi");
      },
      preview,
      15_000,
      undefined,
      undefined,
      diagnostics,
    ).setExternalSessionConnector(async (id) =>
      id === "a" ? f.native : nativeFixture().native,
    );
    try {
      await runtime.openSession("a");
      await vi.waitFor(async () =>
        expect((await runtime.snapshot("a")).runState).toBe("running"),
      );
      const slots = (runtime as unknown as { slots: Map<string, RuntimeSlot> })
        .slots;
      await runtime.openSession("b");
      await vi.waitFor(() => expect(slots.get("a")?.projection).toBeNull());
      const reads = vi.mocked(f.native.read).mock.calls.length;
      await vi.waitFor(
        () =>
          expect(
            vi.mocked(f.native.read).mock.calls.length,
          ).toBeGreaterThanOrEqual(reads + 2),
        { timeout: 2_500 },
      );
      expect(slots.get("a")?.projection).toBeNull();
      expect(
        log.mock.calls.filter(
          ([, event]) => event === "external_session_connection",
        ),
      ).toEqual([]);
      f.setState({ status: "idle" });
      await vi.waitFor(() => expect(slots.get("a")?.runState).toBe("idle"), {
        timeout: 1_500,
      });
      expect(f.native.close).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("uses version-checked native polling and forced prompt admission", async () => {
    const session = await persistedRecord("a");
    const f = nativeFixture();
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      () => {
        throw new Error("must not launch Pi");
      },
    ).setExternalSessionConnector(async () => f.native);
    try {
      await runtime.openSession("a");
      await vi.waitFor(() => expect(f.native.read).toHaveBeenCalled());
      const reconcile = vi.spyOn(SessionProjection.prototype, "reconcile");
      const reads = vi.mocked(f.native.read).mock.calls.length;
      await vi.waitFor(
        () =>
          expect(vi.mocked(f.native.read).mock.calls.length).toBeGreaterThan(
            reads,
          ),
        { timeout: 1_500 },
      );
      expect(reconcile).toHaveBeenCalled();
      expect(reconcile.mock.calls.every(([force]) => force !== true)).toBe(
        true,
      );
      reconcile.mockClear();
      await runtime.prompt({ sessionId: "a", message: "Explicit send" });
      expect(reconcile).toHaveBeenCalledWith(true);
    } finally {
      await runtime.close();
    }
  });

  it.each(["working", "blocked"] as const)(
    "deletes connected native %s sessions singly and through Hidden without interrupting Pi",
    async (status) => {
      const sessions = [await persistedRecord("a"), await persistedRecord("b")];
      const connections = [nativeFixture(), nativeFixture()];
      for (const connection of connections) connection.setState({ status });
      const remove = vi.fn(async () => "trashed" as const);
      const runtime = new RuntimeController(
        catalog(sessions),
        trackedAttachmentStore(),
        () => {
          throw new Error("must not launch Pi");
        },
        undefined,
        15_000,
        undefined,
        remove,
      ).setExternalSessionConnector(
        async (id) => connections[id === "a" ? 0 : 1]!.native,
      );
      try {
        await runtime.openSession("a");
        await vi.waitFor(async () =>
          expect((await runtime.snapshot("a")).sessionStatuses.a).toMatchObject(
            { external: true, runState: "running" },
          ),
        );
        await expect(runtime.deleteSession("a")).resolves.toMatchObject({
          disposition: "trashed",
        });
        await runtime.openSession("b");
        await vi.waitFor(async () =>
          expect(
            (await runtime.snapshot("b")).sessionStatuses.b?.external,
          ).toBe(true),
        );
        await expect(
          runtime.clearHiddenSessions(["b"], ["b"], []),
        ).resolves.toMatchObject({ deleted: [{ sessionId: "b" }] });
        expect(remove).toHaveBeenCalledTimes(2);
        for (const connection of connections) {
          expect(connection.native.abort).not.toHaveBeenCalled();
          expect(connection.native.close).toHaveBeenCalledOnce();
        }
      } finally {
        await runtime.close();
      }
    },
  );

  it.each(["prompt", "rename", "abort"] as const)(
    "retains the deletion and maintenance barriers during a Host native %s",
    async (operation) => {
      const f = nativeFixture();
      const entered = deferredSignal();
      const gate = deferredSignal();
      const hold = async () => {
        entered.resolve();
        await gate.promise;
      };
      if (operation === "abort")
        vi.mocked(f.native.abort).mockImplementation(hold);
      else if (operation === "rename")
        vi.mocked(f.native.rename!).mockImplementation(hold);
      else vi.mocked(f.native.prompt).mockImplementation(hold);
      const remove = vi.fn(async () => "trashed" as const);
      const runtime = new RuntimeController(
        catalog([await persistedRecord("a")]),
        trackedAttachmentStore(),
        () => {
          throw new Error("must not launch Pi");
        },
        undefined,
        15_000,
        undefined,
        remove,
      ).setExternalSessionConnector(async () => f.native);
      try {
        await runtime.openSession("a");
        await vi.waitFor(() => expect(f.native.read).toHaveBeenCalled());
        const sending =
          operation === "prompt"
            ? runtime.prompt({ sessionId: "a", message: "Hold" })
            : operation === "rename"
              ? runtime.rename("a", "Hold")
              : runtime.abort("a");
        await entered.promise;
        await expect(runtime.deleteSession("a")).rejects.toMatchObject({
          status: 409,
        });
        expect(runtime.reserveMaintenanceRestart()).toMatchObject({
          kind: "busy",
        });
        expect(remove).not.toHaveBeenCalled();
        gate.resolve();
        await sending;
      } finally {
        gate.resolve();
        await runtime.close();
      }
    },
  );

  it("preserves completed model/thinking changes when an older catalog reply arrives last", async () => {
    const f = nativeFixture();
    const gate = deferredSignal();
    const old = {
      model: { provider: "native", id: "old" },
      thinkingLevel: "off" as const,
    };
    const selected = {
      model: { provider: "native", id: "selected" },
      thinkingLevel: "low" as const,
    };
    const models = [old.model, selected.model];
    f.setState({ status: "idle", modelControls: true, modelSelection: old });
    f.native.models = vi.fn(async () => {
      await gate.promise;
      return { ...old, models };
    });
    f.native.setModel = vi.fn(async () => ({
      ...selected,
      thinkingLevel: "off" as const,
    }));
    f.native.setThinkingLevel = vi.fn(async () => selected);
    const slot = createRuntimeSlot({
      id: "a",
      cwd: "/tmp",
      sessionPath: "/sessions/a.jsonl",
      process: null,
      preview: null,
      projection: await preview(record("a", "/tmp")),
      bridge: null,
      branchRevision: 1,
      incarnationId: "slot-a",
      viewId: "view-a",
    });
    const external = new RuntimeExternalSessions(
      async () => f.native,
      {
        current: () => true,
        emit: vi.fn(),
        assertUsable: vi.fn(),
        released: vi.fn(),
        log: vi.fn(),
        reconcile: async () => {},
      },
      trackedAttachmentStore(),
    );
    try {
      await external.connect(slot);
      const reading = external.models(slot);
      await external.setModel(slot, "native", "selected");
      await external.setThinkingLevel(slot, "low");
      gate.resolve();
      // Both the catalog HTTP reply and subsequent snapshots retain the newer choice.
      expect(await reading).toEqual({ ...selected, models });
      expect(external.modelSelection(slot)).toEqual(selected);
      expect(slot.availableModels).toEqual(models);
    } finally {
      gate.resolve();
      external.close();
    }
  });

  it("rejects a retired catalog before changing the replacement owner's models or selection", async () => {
    const old = nativeFixture(),
      fresh = nativeFixture();
    const gate = deferredSignal();
    const catalogFor = (provider: string) => ({
      models: [{ provider, id: "model" }],
      model: { provider, id: "model" },
      thinkingLevel: "low" as const,
    });
    for (const f of [old, fresh]) {
      f.setState({ status: "idle", modelControls: true });
      f.native.setModel = vi.fn();
      f.native.setThinkingLevel = vi.fn();
    }
    old.native.models = vi.fn(async () => {
      await gate.promise;
      return catalogFor("old");
    });
    fresh.native.models = vi.fn(async () => catalogFor("fresh"));
    const slot = createRuntimeSlot({
      id: "a",
      cwd: "/tmp",
      sessionPath: "/sessions/a.jsonl",
      process: null,
      preview: null,
      projection: await preview(record("a", "/tmp")),
      bridge: null,
      branchRevision: 1,
      incarnationId: "slot-a",
      viewId: "view-a",
    });
    const emit = vi.fn();
    const external = new RuntimeExternalSessions(
      vi.fn().mockResolvedValueOnce(old.native).mockResolvedValue(fresh.native),
      {
        current: () => true,
        emit,
        assertUsable: vi.fn(),
        released: vi.fn(),
        log: vi.fn(),
        reconcile: async () => {},
      },
      trackedAttachmentStore(),
    );
    try {
      await external.connect(slot);
      const pending = external.models(slot);
      const rejected = expect(pending).rejects.toThrow("connection has ended");
      external.detach(slot);
      await external.connect(slot);
      await external.models(slot);
      const events = emit.mock.calls.length;
      gate.resolve();
      await rejected;
      expect(slot.availableModels).toEqual(catalogFor("fresh").models);
      expect(external.modelSelection(slot)).toEqual({
        model: catalogFor("fresh").model,
        thinkingLevel: "low",
      });
      expect(emit).toHaveBeenCalledTimes(events);
    } finally {
      gate.resolve();
      external.close();
    }
  });

  it("coalesces failed native polls until one complete observation succeeds", async () => {
    const f = nativeFixture();
    const slot = createRuntimeSlot({
      id: "a",
      cwd: "/tmp",
      sessionPath: "/sessions/a.jsonl",
      process: null,
      preview: null,
      projection: await preview(record("a", "/tmp")),
      bridge: null,
      branchRevision: 1,
      incarnationId: "slot-a",
      viewId: "view-a",
    });
    const log = vi.fn();
    const reconcile = vi.fn(async (): Promise<unknown> => {
      throw new Error("Projection read failed");
    });
    const external = new RuntimeExternalSessions(
      async () => f.native,
      {
        current: () => true,
        emit: vi.fn(),
        assertUsable: vi.fn(),
        released: vi.fn(),
        log,
        reconcile,
      },
      trackedAttachmentStore(),
      10,
    );
    vi.useFakeTimers();
    try {
      await external.connect(slot);
      await vi.advanceTimersByTimeAsync(20);
      expect(log).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(slot, false);
      reconcile.mockResolvedValueOnce(undefined);
      await vi.advanceTimersByTimeAsync(20);
      expect(log).toHaveBeenCalledTimes(2);
      slot.projection = null;
      const reconciliations = reconcile.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20);
      expect(reconcile).toHaveBeenCalledTimes(reconciliations);
    } finally {
      external.close();
      vi.useRealTimers();
    }
  });

  it("rediscovers an ended native owner on a subsequent open without repeating input", async () => {
    const first = nativeFixture();
    const next = nativeFixture();
    const connect = vi
      .fn()
      .mockResolvedValueOnce(first.native)
      .mockResolvedValue(next.native);
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      () => {
        throw new Error("must not launch Pi");
      },
      preview,
    ).setExternalSessionConnector(connect);
    try {
      await runtime.openSession("a");
      await runtime.prompt({ sessionId: "a", message: "First" });
      first.setState(null);
      await vi.waitFor(
        () => expect(first.native.close).toHaveBeenCalledOnce(),
        { timeout: 1_500 },
      );
      await runtime.openSession("a");
      await runtime.prompt({ sessionId: "a", message: "Fresh" });
      expect(connect).toHaveBeenCalledTimes(2);
      expect(first.native.prompt).toHaveBeenCalledTimes(1);
      expect(next.native.prompt).toHaveBeenCalledExactlyOnceWith(
        "Fresh",
        undefined,
        expect.any(Function),
        undefined,
      );
    } finally {
      await runtime.close();
    }
  });

  it("closes only its connection while discovery is in flight", async () => {
    const f = nativeFixture();
    const gate = deferredSignal();
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      () => {
        throw new Error("must not launch Pi after close");
      },
      preview,
    ).setExternalSessionConnector(async () => {
      await gate.promise;
      return f.native;
    });
    await runtime.openSession("a");
    const closing = runtime.close();
    gate.resolve();
    await closing;
    expect(f.native.close).toHaveBeenCalledOnce();
    expect(f.native.prompt).not.toHaveBeenCalled();
  });
});
