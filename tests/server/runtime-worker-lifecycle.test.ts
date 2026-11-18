import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullDiagnosticLogger } from "../../server/diagnostics.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import type { PendingImageRecovery } from "../../server/runtime-pending-images.js";
import { createRuntimeSlot } from "../../server/runtime-slot.js";
import { RuntimeWorkerLifecycle } from "../../server/runtime-worker-lifecycle.js";
import { emptyPendingQueues } from "../../shared/contracts.js";

import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  fakeRuntime,
  fixtureWorkspace,
  initializeRuntimeFixture,
  persistedRecord,
  preview,
  record,
  schedulingRuntime,
  startWorker,
  TEST_CWD,
  trackedAttachmentStore,
  trackRuntime,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("worker startup and retirement", () => {
  it.each([
    ["existing", "factory"],
    ["existing", "writer inspection"],
    ["new", "startup"],
    ["new", "identity read"],
  ] as const)(
    "drains a %s writer when Host closes during its %s",
    async (kind, stage) => {
      const entered = deferredSignal();
      const gate = deferredSignal();
      const createTransport = vi.fn(() => {
        throw new Error("A retired worker must not launch a Pi transport");
      });
      let worker!: FakeRpc;
      let inspectedWorker: PiRpcProcess | undefined;
      const runtime = new RuntimeController(
        catalog(kind === "existing" ? [record("a", TEST_CWD)] : []),
        trackedAttachmentStore(),
        {
          createProcess: async (options) => {
            if (stage === "writer inspection") {
              inspectedWorker = new PiRpcProcess({
                ...options,
                createTransport,
              });
              vi.spyOn(inspectedWorker, "stop");
              return inspectedWorker;
            }
            worker = new FakeRpc(options);
            if (stage === "factory") {
              entered.resolve();
              await gate.promise;
            } else if (stage === "startup") {
              worker.startGate = gate.promise;
            } else {
              const request = worker.request.bind(worker);
              worker.request = async <T>(command: Record<string, unknown>) => {
                const result = await request<T>(command);
                if (command.type === "get_state") {
                  entered.resolve();
                  await gate.promise;
                }
                return result;
              };
            }
            return worker as unknown as PiRpcProcess;
          },
          openSessionProjection: preview,
        },
      ).setExternalSessionPresence(async () => {
        if (inspectedWorker) {
          entered.resolve();
          await gate.promise;
        }
        return [];
      });
      if (kind === "existing") await runtime.openSession("a");
      const opening =
        kind === "existing"
          ? startWorker(runtime)
          : runtime.newSession(TEST_CWD);
      const rejection = expect(opening).rejects.toThrow(/closing/);
      try {
        if (stage === "startup")
          await vi.waitFor(() => expect(worker?.starts).toBe(1));
        else await entered.promise;
        if (stage === "startup" || stage === "identity read") {
          expect(runtime.ownWorkerTags()).toContain(
            worker.options.env?.PI_ATTACH_CONTROL_TAG,
          );
        }
        const closing = runtime.close();
        if (inspectedWorker)
          expect(inspectedWorker.stop).toHaveBeenCalledOnce();
        else if (stage !== "factory")
          await vi.waitFor(() => expect(worker.stops).toBe(1));
        await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(/closing/);
        gate.resolve();
        await Promise.all([closing, rejection]);
        if (inspectedWorker) expect(createTransport).not.toHaveBeenCalled();
        else {
          expect(worker.starts).toBe(stage === "factory" ? 0 : 1);
          expect(worker.stops).toBe(1);
        }
        expect(runtime.ownWorkerTags()).toEqual(new Set());
        expect(runtime.startupSessionHint).toBeNull();
      } finally {
        gate.resolve();
        await opening.catch(() => {});
        await runtime.close();
      }
    },
  );

  it("replaces only a worker whose exit has been confirmed", async () => {
    const gate = Promise.withResolvers<void>();
    const { runtime, workers } = schedulingRuntime();
    trackRuntime(runtime);
    await runtime.openSession("a");
    await startWorker(runtime);
    const first = workers[0]!;
    const stop = vi.spyOn(first, "stop").mockReturnValueOnce(gate.promise);
    first.emit("event", {
      type: "extension_ui_request",
      id: "old-dialog",
      method: "confirm",
    });
    first.emit("exit", new Error("RPC disconnected"));
    const delivery = runtime.openSession("a").then(() =>
      runtime.prompt({ sessionId: "a", message: "after exit" }),
    );
    try {
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      expect(workers).toHaveLength(1);
      expect((await runtime.snapshot("a")).pendingExtensionUiRequests).toEqual([]);
      gate.resolve();
      await delivery;
      expect(workers).toHaveLength(2);
      first.emit("exit", new Error("Late exit from retired worker"));
      expect((await runtime.snapshot("a")).sessionStatuses.a?.runState).not.toBe("failed");
    } finally {
      gate.resolve();
      await delivery.catch(() => undefined);
      await runtime.close();
    }
  });

  it("rejects an open whose catalog lookup outlives runtime close", async () => {
    const base = catalog([record("a", "/project")]);
    const { promise: catalogGate, resolve: releaseCatalog } = deferredSignal();
    let lookupStarted = false;
    let previewLoads = 0;
    const { runtime } = fakeRuntime({
      source: {
        ...base,
        get: async (id) => {
          lookupStarted = true;
          await catalogGate;
          return base.get(id);
        },
      },
      openSessionProjection: async (session) => {
        previewLoads += 1;
        return preview(session);
      },
    });

    const opening = runtime.openSession("a");
    await vi.waitFor(() => expect(lookupStarted).toBe(true));
    expect(runtime.reserveMaintenanceRestart()).toEqual({
      kind: "busy",
      reason: "in-flight-operation",
    });
    await expect(runtime.close()).resolves.toBeUndefined();
    releaseCatalog();

    await expect(opening).rejects.toThrow(/closing/);
    expect(previewLoads).toBe(0);
    expect(
      (runtime as unknown as { slots: Map<string, unknown> }).slots.size,
    ).toBe(0);
  });

  it.each([
    { reported: true, confirmed: true },
    { reported: true, confirmed: false },
    { reported: false, confirmed: false },
  ])(
    "retains a failed new-session reservation until exit is confirmed (identity=$reported, stop=$confirmed)",
    async ({ reported, confirmed }) => {
      const target = record("new-id", TEST_CWD);
      target.path = join(fixtureWorkspace, "new-id.jsonl");
      const sessions = catalog([target]);
      const lookup = vi.spyOn(sessions, "get");
      const disconnected = new Error("Transport lost before commit");
      const stopping = deferredSignal();
      let finishStop!: (error?: Error) => void;
      const stopped = new Promise<void>((resolve, reject) => {
        finishStop = (error) => (error ? reject(error) : resolve());
      });
      const { runtime, workers } = schedulingRuntime({
        source: sessions,
        configure: (worker) => {
          if (workers.length === 0) {
            worker.stop = () => {
              worker.stops += 1;
              stopping.resolve();
              return stopped;
            };
            worker.responseOverrides.set(
              reported ? "get_commands" : "get_state",
              () => {
                if (confirmed)
                  vi.spyOn(worker, "available", "get").mockReturnValue(false);
                else worker.emit("exit", disconnected);
                throw disconnected;
              },
            );
          }
        },
      });
      const creating = runtime.newSession(TEST_CWD).catch((error) => error);
      await stopping.promise;
      expect(workers[0]?.stops).toBe(1);
      expect(runtime.startupSessionHint).toBeNull();
      const opening = runtime.openSession("new-id").catch((error) => error);
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledWith("new-id"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(workers).toHaveLength(1);

      if (confirmed) {
        await persistedRecord(target.id, target.cwd);
        finishStop();
        expect(await creating).toBe(disconnected);
        expect(await opening).toMatchObject({
          active: { sessionId: "new-id" },
        });
        await startWorker(runtime, "new-id");
        expect(workers).toHaveLength(2);
      } else {
        const unconfirmed = new Error("Worker exit unconfirmed");
        finishStop(unconfirmed);
        expect(await creating).toBe(unconfirmed);
        expect(await opening).toBe(unconfirmed);
        await expect(runtime.openSession("new-id")).rejects.toBe(unconfirmed);
        expect(workers).toHaveLength(1);
      }
      if (confirmed) await expect(runtime.close()).resolves.toBeUndefined();
      else
        await expect(runtime.close()).rejects.toThrow(
          "Worker exit unconfirmed",
        );
    },
  );

  it("retires failed new writers and binds the next writer's startup dialog to its final session", async () => {
    const existing = record("a", "/tmp");
    const openProjection = vi.fn(preview);
    const startupError = new Error("startup failed");
    const invalidPaths = [null, existing.path];
    const { runtime, workers } = schedulingRuntime({
      sessions: [existing],
      openSessionProjection: openProjection,
      configure: (worker) => {
        if (workers.length === 0) return;
        if (workers.length === 1) {
          worker.start = async () => { throw startupError; };
          return;
        }
        if (workers.length <= 3) {
          worker.sessionPath = invalidPaths[workers.length - 2] ?? null;
          return;
        }
        const request = worker.request.bind(worker);
        worker.responseOverrides.set(
          "get_state",
          (command: Record<string, unknown>) => {
            worker.responseOverrides.delete("get_state");
            worker.emit("event", {
              type: "extension_ui_request",
              id: "trust-1",
              method: "confirm",
              title: "Trust?",
            });
            return request(command);
          },
        );
      },
    });
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event));
    trackRuntime(runtime);
    await runtime.openSession("a");
    await startWorker(runtime);
    openProjection.mockClear();
    const owned = runtime.ownWorkerTags();
    for (const error of [
      startupError.message,
      "Pi did not report a session file",
      "Pi created a duplicate session path",
    ]) {
      await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(error);
      expect(runtime.startupSessionHint).toBe("a");
      expect(runtime.ownWorkerTags()).toEqual(owned);
      expect(workers.at(-1)?.stops).toBe(1);
    }
    expect(openProjection).not.toHaveBeenCalled();
    expect(workers[0]?.stops).toBe(0);

    const readiness = vi.fn((event: { type: string }) => {
      if (event.type === "runtime_ready") throw new Error("Observer failed");
    });
    runtime.on("event", readiness);
    const created = await runtime.newSession(TEST_CWD);
    expect(readiness).toHaveBeenCalledWith(
      expect.objectContaining({ type: "runtime_ready", sessionId: "new-id" }),
    );
    runtime.off("event", readiness);
    expect((await runtime.snapshot("new-id")).active?.sessionId).toBe("new-id");
    expect(created.active?.sessionId).toBe("new-id");
    expect(created.pendingExtensionUiRequests).toEqual([
      expect.objectContaining({
        sessionId: "new-id",
        id: "trust-1",
        method: "confirm",
      }),
    ]);
    expect(
      events.filter((event) =>
        String(event.sessionId ?? "").startsWith("pending-"),
      ),
    ).toEqual([]);
    await runtime.extensionUiResponse({
      sessionId: "new-id",
      id: "trust-1",
      value: true,
    });
    expect(workers.at(-1)?.uiResponses).toEqual([
      { id: "trust-1", value: true },
    ]);
    expect(workers.at(-1)?.stops).toBe(0);
  });
});

it("releases the previous worker's view without letting its disposal clear a replacement's state", async () => {
  const clear = vi.fn();
  const lifecycle = new RuntimeWorkerLifecycle(
    {} as ConstructorParameters<typeof RuntimeWorkerLifecycle>[0],
    nullDiagnosticLogger(),
    {
      extensionUi: { clear },
    } as unknown as ConstructorParameters<typeof RuntimeWorkerLifecycle>[2],
  );
  const slot = createRuntimeSlot({
    id: "a",
    cwd: "/tmp",
    sessionPath: "/sessions/a.jsonl",
    process: null,
    preview: null,
    projection: null,
    bridge: null,
    branchRevision: 1,
    incarnationId: "slot-a",
    viewId: "view-a",
  });
  const disposed = deferredSignal();
  const previous = {
    dispose: vi.fn(() => disposed.promise),
  } as unknown as PendingImageRecovery;
  slot.pendingImages = previous;
  slot.piPendingInput = { steering: ["held"], followUp: [] };
  slot.extensionStatuses = { usage: "37%" };
  slot.pendingQueues = { ...emptyPendingQueues(), revision: 4 };

  const released = lifecycle.releaseWorkerView(slot, "replaced");
  expect(clear).toHaveBeenCalledWith(slot, "replaced");
  expect(slot.pendingImages).toBeNull();
  expect(slot.piPendingInput).toEqual({ steering: [], followUp: [] });
  expect(slot.extensionStatuses).toEqual({});
  expect(slot.pendingQueues.revision).toBe(5);

  // The replacement worker takes ownership while old disposal is pending.
  const replacement = { dispose: vi.fn() } as unknown as PendingImageRecovery;
  slot.pendingImages = replacement;
  disposed.resolve();
  await released;
  expect(previous.dispose).toHaveBeenCalledOnce();
  expect(slot.pendingImages).toBe(replacement);
  expect(replacement.dispose).not.toHaveBeenCalled();
});
