import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PiRpcProcess } from "../../server/pi-rpc.js";

import {
  MAX_IDLE_WORKERS,
  PI_STARTUP_RESPONSE_UI_ERROR,
  RuntimeController,
} from "../../server/runtime.js";

import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  fixtureWorkspace,
  initializeRuntimeFixture,
  preview,
  record,
  schedulingRuntime,
  TEST_CWD,
  trackedAttachmentStore,
  waitForReady,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("worker startup and retirement", () => {
  it("keeps existing and new sessions usable when project discovery cannot be saved", async () => {
    const attachments = trackedAttachmentStore();
    const source = catalog([record("a", TEST_CWD)]);
    const registrationError = new Error("Maintenance storage is unavailable");
    const remember = vi.fn(async () => {});
    source.rememberProjectCwds = remember;
    remember.mockRejectedValue(registrationError);
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      source,
      attachments,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      const opened = await runtime.openSession("a");
      expect(opened.active?.sessionId).toBe("a");
      expect(opened.active?.transcriptPage.messages).toEqual([
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
      expect(remember).toHaveBeenCalledWith([await realpath(TEST_CWD)]);
    } finally {
      await runtime.close();
    }
  });
  it.each(["existing", "new"] as const)(
    "does not start a %s writer after shutdown while its factory is preparing",
    async (kind) => {
      const gate = deferredSignal();
      let worker: FakeRpc | undefined;
      const runtime = new RuntimeController(
        catalog([record("a", TEST_CWD)]),
        trackedAttachmentStore(),
        async (options) => {
          worker = new FakeRpc(options);
          await gate.promise;
          return worker as unknown as PiRpcProcess;
        },
        preview,
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

  it("waits for a busy session's confirmed handoff without stopping other sessions", async () => {
    const f = schedulingRuntime({
      sessions: [record("a", TEST_CWD), record("b", TEST_CWD)],
    });
    const stopped = deferredSignal();
    let released = false;
    try {
      await f.runtime.openSession("a");
      await waitForReady(f.runtime, "a");
      await f.runtime.openSession("b");
      await waitForReady(f.runtime, "b");
      f.workers[0]!.emit("event", { type: "agent_start" });
      await expect(
        f.runtime.setSessionExecution("a", "terminal"),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.workers[0]!.stops).toBe(0);
      f.workers[0]!.stop = async () => {
        f.workers[0]!.stops += 1;
        await stopped.promise;
      };
      const handingOff = f.runtime
        .setSessionExecution("a", "terminal", true)
        .then((result) => {
          released = true;
          return result;
        });
      await vi.waitFor(() => expect(f.workers[0]!.stops).toBe(1));
      expect(released).toBe(false);
      await f.runtime.setThinkingLevel("b", "high");
      expect(f.workers[1]!.stops).toBe(0);
      stopped.resolve();
      expect((await handingOff).active?.readOnlyReason).toBe("terminal");
      expect((await f.runtime.openSession("a")).active?.readOnlyReason).toBe(
        "terminal",
      );
      expect(f.workers).toHaveLength(2);
      expect(f.workers[1]!.stops).toBe(0);
    } finally {
      stopped.resolve();
      await f.runtime.close();
    }
  });

  it("creates the selected directory only on explicit new-session admission, before starting Pi", async () => {
    const cwd = join(fixtureWorkspace, "projects", "new-project");
    const source = catalog([]);
    source.rememberProjectCwds = vi.fn(async () => {});
    const create = vi.fn((options) => {
      expect(existsSync(cwd)).toBe(true);
      return new FakeRpc(options) as unknown as PiRpcProcess;
    });
    const runtime = new RuntimeController(
      source,
      trackedAttachmentStore(),
      create,
      preview,
    );
    try {
      await expect(runtime.newSession(cwd)).rejects.toMatchObject({
        status: 400,
        code: "PROJECT_DIRECTORY_MISSING",
      });
      expect(create).not.toHaveBeenCalled();
      expect(existsSync(cwd)).toBe(false);
      const snapshot = await runtime.newSession(cwd, {
        createDirectory: true,
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        thinkingLevel: "high",
      });
      expect((await stat(cwd)).isDirectory()).toBe(true);
      expect(snapshot.active?.cwd).toBe(create.mock.calls[0]![0].cwd);
      expect(source.rememberProjectCwds).toHaveBeenCalledWith([
        snapshot.active!.cwd,
      ]);
      expect(create.mock.calls[0]![0].args).toEqual(
        expect.arrayContaining([
          "--model",
          "anthropic/claude-sonnet-4",
          "--thinking",
          "high",
        ]),
      );
    } finally {
      await runtime.close();
    }
  });

  it("rejects a new worker without a session path regardless of projection injection", async () => {
    let worker!: FakeRpc;
    const openProjection = vi.fn(preview);
    const runtime = new RuntimeController(
      catalog([]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        worker.sessionPath = null;
        return worker as unknown as PiRpcProcess;
      },
      openProjection,
    );
    try {
      await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(
        "Pi did not report a session file",
      );
      expect(openProjection).not.toHaveBeenCalled();
      expect(worker.stops).toBe(1);
      expect(runtime.activeSessionId).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it.each([
    ["unexpected exit", "confirmed"],
    ["unexpected exit", "unconfirmed"],
    ["idle eviction", "confirmed"],
    ["idle eviction", "unconfirmed"],
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
      const workers: FakeRpc[] = [];
      const ids = Array.from({ length: MAX_IDLE_WORKERS + 2 }, (_, index) =>
        String(index),
      );
      const runtime = new RuntimeController(
        catalog(ids.map((id) => record(id, "/tmp"))),
        trackedAttachmentStore(),
        (options) => {
          const worker = new FakeRpc(options);
          workers.push(worker);
          return worker as unknown as PiRpcProcess;
        },
        preview,
      );
      try {
        await runtime.openSession("0");
        await waitForReady(runtime, "0");
        const old = workers[0]!;
        const stopping = vi.spyOn(old, "stop").mockImplementation(() => stop);
        if (retirement === "unexpected exit") {
          // No pending mutation response supplies an error.stopped fallback.
          old.emit("event", { type: "agent_start" });
          old.emit("exit", new Error("RPC disconnected"));
        } else {
          for (const id of ids.slice(1)) {
            await runtime.openSession(id);
            await waitForReady(runtime, id);
          }
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
        } else {
          const failure = new Error("Old writer exit unconfirmed");
          rejectStop(failure);
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

  it("keeps replacement and prompt writes fenced when stop rejects without exit", async () => {
    const store = trackedAttachmentStore();
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await vi.waitFor(() => expect(workers[0]?.starts).toBe(1));
      workers[0]!.stop = vi.fn(async () => {
        throw new Error("Synthetic exit unconfirmed");
      });
      await expect(
        runtime.nativeCommand({ sessionId: "a", command: "reload" }),
      ).rejects.toThrow("exit unconfirmed");
      await expect(
        runtime.prompt({
          sessionId: "a",
          message: "must not acquire another writer",
        }),
      ).rejects.toThrow("exit unconfirmed");
      expect(workers).toHaveLength(1);
      expect(
        workers[0]!.commands.some((command) => command.type === "prompt"),
      ).toBe(false);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  it("fails promptly and attributes a response-bearing startup UI request", async () => {
    const store = trackedAttachmentStore();
    let worker: FakeRpc | undefined;
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.startupEvent = {
          type: "extension_ui_request",
          id: "startup-confirm",
          method: "confirm",
          title: "startup",
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      const started = Date.now();
      await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(
        PI_STARTUP_RESPONSE_UI_ERROR,
      );
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(worker?.stops).toBeGreaterThan(0);
      const internal = runtime as unknown as {
        slots: Map<string, unknown>;
        provisionalSlots: Map<string, unknown>;
      };
      expect(internal.slots.size).toBe(0);
      expect(internal.provisionalSlots.size).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("allows fire-and-forget startup UI while rejecting no startup response", async () => {
    const store = trackedAttachmentStore();
    let worker: FakeRpc | undefined;
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.startupEvent = {
          type: "extension_ui_request",
          id: "startup-notify",
          method: "notify",
          message: "ready",
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      const snapshot = await runtime.newSession(TEST_CWD);
      expect(snapshot.active?.sessionId).toBe("new-id");
      expect(worker?.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("rejects a new Pi worker that reports a path owned by another slot", async () => {
    const existing = record("a", "/tmp");
    existing.path = resolve("/sessions/a.jsonl");
    const store = trackedAttachmentStore();
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([existing]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        if (workers.length === 2) {
          worker.sessionId = "new-id";
          worker.sessionPath = existing.path;
        }
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await vi.waitFor(() => expect(workers).toHaveLength(1));

      await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(
        "Pi created a duplicate session path",
      );
      expect(workers[1]?.stops).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });

  it.each(["resume", "new"])(
    "adds only internal GUI support, not agent tools or prompt policy (%s)",
    async (mode) => {
      let worker!: FakeRpc;
      const runtime = new RuntimeController(
        catalog([record("a", "/tmp")]),
        trackedAttachmentStore(),
        (options) => {
          worker = new FakeRpc(options);
          return worker as unknown as PiRpcProcess;
        },
        preview,
      );
      try {
        if (mode === "resume") {
          await runtime.openSession("a");
          await waitForReady(runtime);
        } else {
          await runtime.newSession(TEST_CWD);
        }
        expect(worker.options.args).toEqual([
          ...(mode === "resume"
            ? ["--session", resolve("/sessions/a.jsonl")]
            : []),
          "--extension",
          expect.stringMatching(/[\\/]inspire-branch-bridge\.(ts|js)$/),
        ]);
        expect(Object.keys(worker.options.env ?? {}).sort()).toEqual([
          "INSPIRE_BRANCH_COMMAND",
          "INSPIRE_BRANCH_STATUS_KEY",
          "INSPIRE_BRANCH_WORKER_ID",
        ]);
        const message = "Use my configured tools and prompts.";
        await runtime.prompt({ sessionId: worker.sessionId, message });
        expect(worker.commands).toContainEqual(
          expect.objectContaining({ type: "prompt", message }),
        );
      } finally {
        await runtime.close();
      }
    },
  );

  it("does not perform a fallible authoritative snapshot after committing a new session", async () => {
    const store = trackedAttachmentStore();
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
    );
    const internals = runtime as unknown as {
      snapshotSlot(slot: unknown): Promise<unknown>;
    };
    internals.snapshotSlot = async () => {
      throw new Error("post-commit snapshot must not run");
    };
    try {
      const snapshot = await runtime.newSession(TEST_CWD);
      expect(snapshot.active?.sessionId).toBe("new-id");
      expect(runtime.activeSessionId).toBe("new-id");
    } finally {
      await runtime.close();
    }
  });

  it("starts a new Pi worker with the selected model and thinking level", async () => {
    const store = trackedAttachmentStore();
    let worker: FakeRpc | undefined;
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        // Match Pi's normal new-session behavior: it reserves a JSONL pathname
        // before the first prompt, but has not written a thinking-level entry.
        worker.sessionPath = join(fixtureWorkspace, "new-id.jsonl");
        const request = worker.request.bind(worker);
        worker.request = async <T>(
          command: Record<string, unknown>,
        ): Promise<T> => {
          const result = await request<T>(command);
          return command.type === "get_state"
            ? ({
                ...(result as object),
                thinkingLevel: "high",
                model: { provider: "anthropic", id: "claude-sonnet-4" },
              } as T)
            : result;
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      const snapshot = await runtime.newSession(TEST_CWD, {
        name: "  Tuned session  ",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        thinkingLevel: "high",
      });
      expect(worker?.options.args).toEqual(
        expect.arrayContaining([
          "--name",
          "Tuned session",
          "--model",
          "anthropic/claude-sonnet-4",
          "--thinking",
          "high",
        ]),
      );
      expect(worker?.options.args?.at(-2)).toBe("--extension");
      expect(snapshot.active).toMatchObject({
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        thinkingLevel: "high",
      });
      // A later snapshot previously painted the pending projection's `off`
      // default while its explicit --thinking selection still awaited JSONL.
      expect((await runtime.snapshot()).active).toMatchObject({
        thinkingLevel: "high",
      });
    } finally {
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
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
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
    expect(recovered.active?.transcriptPage.messages).toEqual([
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
    const store = trackedAttachmentStore();
    const base = catalog([record("a", "/project")]);
    const { promise: catalogGate, resolve: releaseCatalog } = deferredSignal();
    let lookupStarted = false;
    let previewLoads = 0;
    const runtime = new RuntimeController(
      {
        ...base,
        get: async (id) => {
          lookupStarted = true;
          await catalogGate;
          return base.get(id);
        },
      },
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      async (session) => {
        previewLoads += 1;
        return preview(session);
      },
    );

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
      (options) => {
        worker = new PiRpcProcess({ ...options, createTransport });
        return worker;
      },
      preview,
    ).setExternalSessionGuard(guard);
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

  it("owns and drains a provisional new-session worker during concurrent close", async () => {
    const store = trackedAttachmentStore();
    let worker!: FakeRpc;
    const { promise: startGate, resolve: releaseStart } = deferredSignal();
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.startGate = startGate;
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    const creating = runtime.newSession(TEST_CWD);
    await vi.waitFor(() => expect(worker?.starts).toBe(1));
    const closing = runtime.close();
    await vi.waitFor(() => expect(worker.stops).toBe(1));
    await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(/closing/);
    releaseStart();
    await expect(creating).rejects.toThrow(/closing/);
    await expect(closing).resolves.toBeUndefined();
    const internal = runtime as unknown as {
      slots: Map<string, unknown>;
      provisionalSlots: Map<string, unknown>;
    };
    expect(internal.slots.size).toBe(0);
    expect(internal.provisionalSlots.size).toBe(0);
    expect(worker.stops).toBe(1);
  });

  it("atomically cleans a provisional identity-rebind race and startup failure", async () => {
    const store = trackedAttachmentStore();
    const workers: FakeRpc[] = [];
    const { promise: identityGate, resolve: releaseIdentity } =
      deferredSignal();
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        const request = worker.request.bind(worker);
        worker.request = async <T>(command: Record<string, unknown>) => {
          const result = await request<T>(command);
          if (command.type === "get_state") await identityGate;
          return result;
        };
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    const creating = runtime.newSession(TEST_CWD);
    await vi.waitFor(() =>
      expect(
        workers[0]?.commands.some((command) => command.type === "get_state"),
      ).toBe(true),
    );
    const closing = runtime.close();
    await vi.waitFor(() => expect(workers[0]?.stops).toBe(1));
    releaseIdentity();
    await expect(creating).rejects.toThrow(/closing/);
    await closing;
    const internal = runtime as unknown as {
      slots: Map<string, unknown>;
      provisionalSlots: Map<string, unknown>;
    };
    expect(internal.slots.size).toBe(0);
    expect(internal.provisionalSlots.size).toBe(0);
    expect(workers.reduce((sum, worker) => sum + worker.starts, 0)).toBe(1);
    expect(workers.reduce((sum, worker) => sum + worker.stops, 0)).toBe(1);
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
      const workers: FakeRpc[] = [];
      const disconnected = new Error("Transport lost before commit");
      const stopping = deferredSignal();
      let finishStop!: (error?: Error) => void;
      const stopped = new Promise<void>((resolve, reject) => {
        finishStop = (error) => (error ? reject(error) : resolve());
      });
      const runtime = new RuntimeController(
        sessions,
        trackedAttachmentStore(),
        (options) => {
          const worker = new FakeRpc(options);
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
          workers.push(worker);
          return worker as unknown as PiRpcProcess;
        },
        preview,
      );
      const creating = runtime.newSession(TEST_CWD).catch((error) => error);
      await stopping.promise;
      expect(workers[0]?.stops).toBe(1);
      const opening = runtime.openSession("new-id").catch((error) => error);
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledWith("new-id"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(workers).toHaveLength(1);

      if (confirmed) {
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

  it("unregisters and stops a provisional worker whose startup fails", async () => {
    const store = trackedAttachmentStore();
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.start = async () => {
          worker.starts += 1;
          throw new Error("startup failed");
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await expect(runtime.newSession(TEST_CWD)).rejects.toThrow(
      /startup failed/,
    );
    const internal = runtime as unknown as {
      slots: Map<string, unknown>;
      provisionalSlots: Map<string, unknown>;
    };
    expect(internal.slots.size).toBe(0);
    expect(internal.provisionalSlots.size).toBe(0);
    expect(worker.starts).toBe(1);
    expect(worker.stops).toBe(1);
    await runtime.close();
  });

  it("rebinds an extension dialog raised before Pi reports the final session id", async () => {
    const store = trackedAttachmentStore();
    let worker!: FakeRpc;
    const events: Array<Record<string, unknown>> = [];
    const runtime = new RuntimeController(
      catalog([]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        const request = worker.request.bind(worker);
        worker.request = async <T>(
          command: Record<string, unknown>,
        ): Promise<T> => {
          const result = await request<T>(command);
          if (command.type === "get_state") {
            // Arrives after RPC startup while the slot still carries its
            // provisional identity.
            worker.emit("event", {
              type: "extension_ui_request",
              id: "trust-1",
              method: "confirm",
              title: "Trust?",
            });
          }
          return result;
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );

    const created = await runtime.newSession(TEST_CWD);
    expect(created.active?.sessionId).toBe("new-id");
    expect(created.pendingExtensionUiRequests).toEqual([
      expect.objectContaining({
        sessionId: "new-id",
        id: "trust-1",
        method: "confirm",
      }),
    ]);
    // No event may ever leave the host addressed to a pending-* session.
    expect(
      events.every(
        (event) => !String(event.sessionId ?? "").startsWith("pending-"),
      ),
    ).toBe(true);
    await runtime.extensionUiResponse({
      sessionId: "new-id",
      id: "trust-1",
      value: true,
    });
    expect(worker.uiResponses).toEqual([{ id: "trust-1", value: true }]);
    await runtime.close();
  });
});
