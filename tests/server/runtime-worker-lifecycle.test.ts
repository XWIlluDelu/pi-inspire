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
  TEST_CWD,
  trackedAttachmentStore,
  trackRuntime,
  waitForReady,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("worker startup and retirement", () => {
  it("warms only the current selection and starts a superseded preview on demand", async () => {
    const entered = deferredSignal();
    const resume = deferredSignal();
    const { runtime, workers } = schedulingRuntime({
      sessions: [record("a", TEST_CWD), record("b", TEST_CWD)],
      openSessionProjection: async (session) => {
        if (session.id === "a") {
          entered.resolve();
          await resume.promise;
        }
        return preview(session);
      },
    });
    const opening = runtime.openSession("a");
    try {
      await entered.promise;
      await runtime.openSession("b");
      await waitForReady(runtime, "b");
      resume.resolve();

      expect((await opening).active).toMatchObject({
        sessionId: "a",
        transcriptPage: { messages: [{ content: "preview:a" }] },
      });
      expect((await runtime.snapshot()).active?.sessionId).toBe("b");
      expect(workers.map((worker) => worker.sessionId)).toEqual(["b"]);

      const release = runtime.retainSessionView("a");
      try {
        const snapshot = await runtime.snapshot("a");
        await runtime.prompt({
          sessionId: "a",
          expectedViewId: snapshot.active?.transcriptPage.viewId,
          message: "Continue in this view",
        });
        expect(workers.map((worker) => worker.sessionId)).toEqual(["b", "a"]);
        expect(runtime.activeSessionId).toBe("b");
      } finally {
        release();
      }
    } finally {
      resume.resolve();
      await opening.catch(() => undefined);
      await runtime.close();
    }
  });

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
    await waitForReady(runtime, "a");
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
  it.each(["existing", "new"] as const)(
    "does not start a %s writer after shutdown while its factory is preparing",
    async (kind) => {
      const gate = deferredSignal();
      let worker: FakeRpc | undefined;
      const runtime = new RuntimeController(
        catalog([record("a", TEST_CWD)]),
        trackedAttachmentStore(),
        {
          createProcess: async (options) => {
            worker = new FakeRpc(options);
            await gate.promise;
            return worker as unknown as PiRpcProcess;
          },
          openSessionProjection: preview,
        },
      );
      const opening =
        kind === "existing"
          ? runtime.openSession("a")
          : runtime.newSession(TEST_CWD);
      const outcome = opening.catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(worker).toBeDefined());
        const closing = runtime.close();
        gate.resolve();
        await closing;
        const result = await outcome;
        if (kind === "new") expect(result).toBeInstanceOf(Error);
        expect(worker!.starts).toBe(0);
        expect(worker!.stops).toBe(1);
      } finally {
        gate.resolve();
        await outcome;
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
    expect((await runtime.snapshot()).active).toMatchObject({
      model,
      thinkingLevel: "high",
    });
  });

  it("rejects a new worker without a session path regardless of projection injection", async () => {
    let worker!: FakeRpc;
    const openProjection = vi.fn(preview);
    const runtime = new RuntimeController(
      catalog([]),
      trackedAttachmentStore(),
      {
        createProcess: (options) => {
          worker = new FakeRpc(options);
          worker.sessionPath = null;
          return worker as unknown as PiRpcProcess;
        },
        openSessionProjection: openProjection,
      },
    );
    trackRuntime(runtime);
    await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(
      "Pi did not report a session file",
    );
    expect(openProjection).not.toHaveBeenCalled();
    expect(worker.stops).toBe(1);
    expect(runtime.activeSessionId).toBeNull();
  });

  it.each([
    ["unexpected exit", "confirmed"],
    ["unexpected exit", "unconfirmed"],
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
      const { runtime, workers } = schedulingRuntime({
        sessions: ids.map((id) => record(id, "/tmp")),
      });
      try {
        await runtime.openSession("0");
        await waitForReady(runtime, "0");
        const old = workers[0]!;
        const stopping = vi.spyOn(old, "stop").mockImplementation(() => stop);
        let reloading: Promise<unknown> | undefined;
        if (retirement === "unexpected exit") {
          // No pending mutation response supplies an error.stopped fallback.
          old.emit("event", { type: "agent_start" });
          old.emit("exit", new Error("RPC disconnected"));
        } else if (retirement === "idle eviction") {
          for (const id of ids.slice(1)) {
            await runtime.openSession(id);
            await waitForReady(runtime, id);
          }
        } else {
          reloading = runtime
            .nativeCommand({ sessionId: "0", command: "reload" })
            .catch((error: unknown) => error);
        }
        await vi.waitFor(() => expect(stopping).toHaveBeenCalledOnce());
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
          expect(current.runState).not.toBe("failed");
        } else {
          const failure = new Error("Old writer exit unconfirmed");
          rejectStop(failure);
          if (reloading) expect(await reloading).toBe(failure);
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

  it("rejects a new Pi worker that reports a path owned by another slot", async () => {
    const existing = record("a", "/tmp");
    const store = trackedAttachmentStore();
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(catalog([existing]), store, {
      createProcess: (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        if (workers.length === 2) {
          worker.sessionId = "new-id";
          worker.sessionPath = existing.path;
        }
        return worker as unknown as PiRpcProcess;
      },
      openSessionProjection: preview,
    });
    trackRuntime(runtime);
    await runtime.openSession("a");
    await vi.waitFor(() => expect(workers).toHaveLength(1));

    await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(
      "Pi created a duplicate session path",
    );
    expect(workers[1]?.stops).toBeGreaterThan(0);
  });

  it("returns the created session even if a readiness observer fails", async () => {
    const { runtime } = schedulingRuntime({ sessions: [] });
    const observer = vi.fn((event: { type: string }) => {
      if (event.type === "runtime_ready") throw new Error("Observer failed");
    });
    runtime.on("event", observer);
    try {
      const created = await runtime.newSession(TEST_CWD);
      expect(observer).toHaveBeenCalledWith(
        expect.objectContaining({ type: "runtime_ready", sessionId: "new-id" }),
      );
      expect(created.active?.sessionId).toBe("new-id");
      expect((await runtime.snapshot()).active?.sessionId).toBe("new-id");
    } finally {
      runtime.off("event", observer);
      await runtime.close();
    }
  });

  it("keeps a read-only recovery snapshot and clears stale extension UI after worker exit", async () => {
    const store = trackedAttachmentStore();
    const f = schedulingRuntime({ attachments: store });
    const { runtime } = f;
    const emitted: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) =>
      emitted.push(event as Record<string, unknown>),
    );

    await runtime.openSession("a");
    await waitForReady(runtime);
    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "question-1",
      method: "confirm",
    });
    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "widget-1",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["one"],
    });
    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      statusKey: "usage",
      statusText: "37%",
    });
    expect((await runtime.snapshot()).extensionDisplays).toHaveLength(1);
    f.worker.emit("exit", new Error("worker crashed"));

    const recovered = await runtime.snapshot();
    expect(recovered.active?.transcriptPage.messages).toMatchObject([
      { role: "user", content: "preview:a", timestamp: 1 },
    ]);
    expect(recovered.runState).toBe("failed");
    expect(recovered.pendingExtensionUiRequests).toEqual([]);
    expect(recovered.extensionDisplays).toEqual([]);
    expect(recovered.extensionStatuses).toEqual({});
    expect(recovered.sessionStatuses.a).toEqual({ runState: "failed" });
    expect(emitted.at(-1)).toMatchObject({
      type: "runtime_error",
      extensionDisplays: [],
      extensionStatuses: {},
    });
    await runtime.close();
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
    await expect(runtime.close()).resolves.toBeUndefined();
    releaseCatalog();

    await expect(opening).rejects.toThrow(/closing/);
    expect(previewLoads).toBe(0);
    expect(
      (runtime as unknown as { slots: Map<string, unknown> }).slots.size,
    ).toBe(0);
  });

  it("does not start a prepared worker after close retires it during writer inspection", async () => {
    const inspected = deferredSignal();
    const releaseInspection = deferredSignal();
    const createTransport = vi.fn(() => {
      throw new Error("A retired worker must not launch a Pi transport");
    });
    let worker!: PiRpcProcess;
    const guard = vi.fn(async () => {
      // The first inspection precedes process creation. The second runs after
      // attaching the unstarted worker and validating its projection baseline.
      if (guard.mock.calls.length === 2) {
        inspected.resolve();
        await releaseInspection.promise;
      }
    });
    const runtime = new RuntimeController(
      catalog([record("a", TEST_CWD)]),
      trackedAttachmentStore(),
      {
        createProcess: (options) => {
          worker = new PiRpcProcess({ ...options, createTransport });
          return worker;
        },
        openSessionProjection: preview,
      },
    ).setExternalSessionPresence(async () => {
      await guard();
      return [];
    });
    try {
      await runtime.openSession("a");
      await inspected.promise;
      const stop = vi.spyOn(worker, "stop");
      expect(createTransport.mock.calls.length).toBe(0);
      const closing = runtime.close();
      expect(stop).toHaveBeenCalledOnce();
      releaseInspection.resolve();
      await closing;
      expect(createTransport.mock.calls.length).toBe(0);
      expect(runtime.activeSessionId).toBeNull();
    } finally {
      releaseInspection.resolve();
      await runtime.close();
    }
  });

  it.each(["startup", "identity confirmation"] as const)(
    "drains a provisional new-session writer during %s on close",
    async (stage) => {
      let worker!: FakeRpc;
      const entered = deferredSignal();
      const gate = deferredSignal();
      const runtime = new RuntimeController(
        catalog([]),
        trackedAttachmentStore(),
        {
          createProcess: (options) => {
            worker = new FakeRpc(options);
            if (stage === "startup") worker.startGate = gate.promise;
            const request = worker.request.bind(worker);
            worker.request = async <T>(command: Record<string, unknown>) => {
              const result = await request<T>(command);
              if (
                stage === "identity confirmation" &&
                command.type === "get_state"
              ) {
                entered.resolve();
                await gate.promise;
              }
              return result;
            };
            return worker as unknown as PiRpcProcess;
          },
          openSessionProjection: preview,
        },
      );
      const creating = runtime.newSession(TEST_CWD);
      const rejection = expect(creating).rejects.toThrow(/closing/);
      try {
        if (stage === "startup")
          await vi.waitFor(() => expect(worker?.starts).toBe(1));
        else await entered.promise;
        expect(runtime.ownWorkerTags()).toContain(
          worker.options.env?.PI_ATTACH_CONTROL_TAG,
        );
        const closing = runtime.close();
        await vi.waitFor(() => expect(worker.stops).toBe(1));
        await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(/closing/);
        gate.resolve();
        await rejection;
        await closing;
        expect(runtime.ownWorkerTags()).toEqual(new Set());
        expect(runtime.activeSessionId).toBeNull();
        expect(worker.stops).toBe(1);
      } finally {
        gate.resolve();
        await runtime.close();
      }
    },
  );

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
        await waitForReady(runtime, "new-id");
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

  it("retires a failed new writer and binds the next writer's startup dialog to its final session", async () => {
    const { runtime, workers } = schedulingRuntime({
      sessions: [],
      configure: (worker) => {
        if (workers.length === 0) {
          worker.start = async () => {
            throw new Error("startup failed");
          };
          return;
        }
        const request = worker.request.bind(worker);
        worker.request = async <T>(command: Record<string, unknown>) => {
          if (command.type === "get_state") {
            worker.request = request;
            worker.emit("event", {
              type: "extension_ui_request",
              id: "trust-1",
              method: "confirm",
              title: "Trust?",
            });
          }
          return request<T>(command);
        };
      },
    });
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event));
    trackRuntime(runtime);
    await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(
      "startup failed",
    );
    expect(runtime.activeSessionId).toBeNull();
    expect(runtime.ownWorkerTags()).toEqual(new Set());
    expect(workers[0]?.stops).toBe(1);

    const created = await runtime.newSession(TEST_CWD);
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
    expect(workers[1]?.uiResponses).toEqual([{ id: "trust-1", value: true }]);
    expect(workers[1]?.stops).toBe(0);
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
