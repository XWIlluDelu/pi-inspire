import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullDiagnosticLogger } from "../../server/diagnostics.js";
import { type PiRpcOptions, PiRpcProcess } from "../../server/pi-rpc.js";
import { MAX_IDLE_WORKERS, RuntimeController } from "../../server/runtime.js";
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
  it("keeps existing and new sessions usable when project discovery cannot be saved", async () => {
    const source = catalog([record("a", TEST_CWD)]);
    const registrationError = new Error("Maintenance storage is unavailable");
    const remember = vi.fn(async () => {});
    source.rememberProjectCwd = remember;
    remember.mockRejectedValue(registrationError);
    const { runtime, workers } = schedulingRuntime({
      source: source,
    });
    trackRuntime(runtime);
    const opened = await runtime.openSession("a");
    expect(opened.active?.sessionId).toBe("a");
    expect(opened.active?.transcriptPage.messages).toMatchObject([
      { role: "user", content: "preview:a", timestamp: 1 },
    ]);
    await startWorker(runtime, "a");
    expect(workers[0]?.starts).toBe(1);
    expect(workers[0]?.stops).toBe(0);
    await expect(
      runtime.prompt({ sessionId: "a", message: "ordinary text" }),
    ).resolves.toBeDefined();
    const created = await runtime.newSession(TEST_CWD);
    expect(created.active?.sessionId).toBe("new-id");
    expect(workers[1]?.starts).toBe(1);
    expect(remember).toHaveBeenCalledWith(await realpath(TEST_CWD));
  });
  it.each([
    ["existing", "factory"],
    ["existing", "writer inspection"],
    ["new", "factory"],
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

  it("creates a directory only on explicit admission and retains selected Pi settings before the first write", async () => {
    const cwd = join(fixtureWorkspace, "projects", "new-project");
    const source = catalog([]);
    source.rememberProjectCwd = vi.fn(async () => {});
    const model = { provider: "anthropic", id: "claude-sonnet-4" };
    const sessionFile = join(fixtureWorkspace, "new-id.jsonl");
    const create = vi.fn((options: PiRpcOptions) => {
      expect(existsSync(cwd)).toBe(true);
      const worker = new FakeRpc(options);
      worker.responseOverrides.set("get_state", {
        sessionId: worker.sessionId,
        sessionFile: worker.sessionPath,
        isStreaming: false,
        isCompacting: false,
        thinkingLevel: "high",
        model,
      });
      return worker as unknown as PiRpcProcess;
    });
    const runtime = new RuntimeController(source, trackedAttachmentStore(), {
      createProcess: create,
      openSessionProjection: preview,
    });
    trackRuntime(runtime);
    await expect(runtime.newSession(cwd)).rejects.toMatchObject({
      status: 400,
      code: "PROJECT_DIRECTORY_MISSING",
    });
    expect(create).not.toHaveBeenCalled();
    expect(existsSync(cwd)).toBe(false);
    const snapshot = await runtime.newSession(cwd, {
      createDirectory: true,
      name: "  Tuned session  ",
      model,
      thinkingLevel: "high",
    });
    expect((await stat(cwd)).isDirectory()).toBe(true);
    expect(snapshot.active).toMatchObject({
      cwd: create.mock.calls[0]![0].cwd,
      sessionFile,
      model,
      thinkingLevel: "high",
    });
    expect(source.rememberProjectCwd).toHaveBeenCalledWith(
      snapshot.active!.cwd,
    );
    expect(create.mock.calls[0]![0].args).toEqual(
      expect.arrayContaining([
        "--name",
        "Tuned session",
        "--model",
        "anthropic/claude-sonnet-4",
        "--thinking",
        "high",
      ]),
    );
    expect(existsSync(sessionFile)).toBe(false);
    expect((await runtime.snapshot("new-id")).active).toMatchObject({
      model,
      thinkingLevel: "high",
    });
  });

  it.each([
    ["unexpected exit", "confirmed"],
    ["unexpected exit", "unconfirmed"],
    ["failed startup", "confirmed"],
    ["failed startup", "unconfirmed"],
    ["idle eviction", "confirmed"],
    ["explicit reload", "unconfirmed"],
  ] as const)(
    "fences replacement after %s until stop is %s",
    async (retirement, outcome) => {
      const errors = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      let confirmStop!: () => void;
      let rejectStop!: (error: Error) => void;
      const stop = new Promise<void>((resolve, reject) => {
        confirmStop = resolve;
        rejectStop = reject;
      });
      const ids = Array.from({ length: MAX_IDLE_WORKERS + 2 }, (_, index) =>
        String(index),
      );
      const firstFailure = new Error("Pi failed during startup");
      const { runtime, workers } = schedulingRuntime({
        sessions: ids.map((id) => record(id, "/tmp")),
        configure(worker) {
          if (workers.length !== 0) return;
          if (retirement === "failed startup") {
            vi.spyOn(worker, "start").mockRejectedValueOnce(firstFailure);
          }
          vi.spyOn(worker, "stop").mockReturnValueOnce(stop);
        },
      });
      try {
        await runtime.openSession("0");
        let failedStartup: Promise<unknown> | undefined;
        if (retirement === "failed startup") {
          failedStartup = startWorker(runtime, "0").catch(
            (error: unknown) => error,
          );
          await vi.waitFor(() => expect(workers).toHaveLength(1));
        } else await startWorker(runtime, "0");
        const old = workers[0]!;
        const stopping = vi.mocked(old.stop);
        let reloading: Promise<unknown> | undefined;
        if (retirement === "unexpected exit") {
          old.emit("event", {
            type: "extension_ui_request",
            id: "question",
            method: "confirm",
          });
          old.emit("event", {
            type: "extension_ui_request",
            id: "widget",
            method: "setWidget",
            widgetKey: "plan",
            widgetLines: ["one"],
          });
          old.emit("event", {
            type: "extension_ui_request",
            id: "status",
            method: "setStatus",
            statusKey: "usage",
            statusText: "37%",
          });
          const before = await runtime.snapshot("0");
          expect(before.extensionDisplays).toHaveLength(1);
          expect(before.pendingExtensionUiRequests).toHaveLength(1);
          const reported = vi.fn();
          runtime.on("event", reported);
          old.emit("event", { type: "agent_start" });
          old.emit("exit", new Error("RPC disconnected"));
          expect(await runtime.snapshot("0")).toMatchObject({
            active: {
              transcriptPage: {
                messages: [
                  expect.objectContaining({
                    role: "user",
                    content: "preview:0",
                  }),
                ],
              },
            },
            pendingExtensionUiRequests: [],
            extensionStatuses: {},
            extensionDisplays: [],
            sessionStatuses: {
              "0": {
                runState: "failed",
                indicator: "failed",
                attentionId: expect.any(Number),
              },
            },
          });
          expect(reported).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "runtime_error",
              extensionDisplays: [],
              extensionStatuses: {},
            }),
          );
        } else if (retirement === "idle eviction") {
          for (const id of ids.slice(1)) {
            await runtime.openSession(id);
            await startWorker(runtime, id);
          }
        } else if (retirement === "explicit reload") {
          reloading = runtime
            .nativeCommand({ sessionId: "0", command: "reload" })
            .catch((error: unknown) => error);
        }
        await vi.waitFor(() => expect(stopping).toHaveBeenCalledOnce());
        if (failedStartup)
          expect(runtime.reserveMaintenanceRestart(false, true)).toEqual({
            kind: "busy",
            reason: "in-flight-operation",
          });
        const delivery = runtime
          .openSession("0")
          .then(() =>
            runtime.prompt({ sessionId: "0", message: "after retirement" }),
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        await new Promise<void>((resolveTick) => setImmediate(resolveTick));
        expect(
          workers.filter((worker) => worker.sessionId === "0"),
        ).toHaveLength(1);

        if (outcome === "confirmed") {
          confirmStop();
          if (failedStartup) expect(await failedStartup).toBe(firstFailure);
          expect(await delivery).toBeNull();
          expect(
            workers.filter((worker) => worker.sessionId === "0"),
          ).toHaveLength(2);
          old.emit("event", {
            type: "extension_ui_request",
            id: "late-status",
            method: "setStatus",
            statusKey: "retired-worker",
            statusText: "stale",
          });
          old.emit("exit", new Error("Late exit from retired worker"));
          const current = await runtime.snapshot("0");
          expect(current.extensionStatuses).not.toHaveProperty(
            "retired-worker",
          );
          expect(current.sessionStatuses["0"]?.runState).not.toBe("failed");
        } else {
          const failure = new Error("Old writer exit unconfirmed");
          rejectStop(failure);
          if (reloading) expect(await reloading).toBe(failure);
          if (failedStartup) {
            expect(await failedStartup).toBeInstanceOf(Error);
            expect(runtime.reserveMaintenanceRestart(false, true)).toEqual({
              kind: "busy",
              reason: "in-flight-operation",
            });
          }
          expect(await delivery).toBe(failure);
          await expect(runtime.openSession("0")).rejects.toThrow(
            "Old writer exit unconfirmed",
          );
          expect(
            workers.filter((worker) => worker.sessionId === "0"),
          ).toHaveLength(1);
        }
      } finally {
        confirmStop();
        await runtime.close().catch(() => undefined);
        errors.mockRestore();
      }
    },
  );

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
                worker.emit("exit", disconnected);
                throw disconnected;
              },
            );
          }
        },
      });
      const creating = runtime.newSession(TEST_CWD).catch((error) => error);
      await stopping.promise;
      expect(workers[0]?.stops).toBe(1);
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
    const rejected = [
      {
        configure: (worker: FakeRpc) => {
          worker.start = async () => {
            throw startupError;
          };
        },
        error: startupError.message,
      },
      {
        configure: (worker: FakeRpc) => {
          worker.sessionPath = null;
        },
        error: "Pi did not report a session file",
      },
      {
        configure: (worker: FakeRpc) => {
          worker.sessionPath = existing.path;
        },
        error: "Pi created a duplicate session path",
      },
    ];
    const { runtime, workers } = schedulingRuntime({
      sessions: [existing],
      openSessionProjection: openProjection,
      configure: (worker) => {
        if (workers.length === 0) return;
        const failure = rejected[workers.length - 1];
        if (failure) return failure.configure(worker);
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
    for (const failure of rejected) {
      await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(failure.error);
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
