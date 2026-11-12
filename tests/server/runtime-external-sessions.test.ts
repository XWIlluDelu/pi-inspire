import { appendFile, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectExternalSession,
  ExternalSessionConnection,
  ExternalSessionRead,
  ExternalSessionState,
} from "../../server/external-session.js";
import { HostRestartController } from "../../server/host-restart.js";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import {
  RuntimeController,
  type RuntimeControllerOptions,
} from "../../server/runtime.js";
import { RuntimeExternalSessions } from "../../server/runtime-external-sessions.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import { createRuntimeSlot } from "../../server/runtime-slot.js";
import type { SessionRecord } from "../../server/session-catalog.js";
import { parseAttachmentContext } from "../../shared/attachment-context.js";
import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  fakeRuntime,
  initializeRuntimeFixture,
  persistedRecord,
  preview,
  record,
  trackedAttachmentStore,
  trackRuntime,
  upload,
  waitForReady,
} from "./fixtures/runtime.js";

const directProjections: Awaited<ReturnType<typeof preview>>[] = [];

beforeEach(initializeRuntimeFixture);
afterEach(async () => {
  try {
    await Promise.all(
      directProjections.splice(0).map((projection) => projection.close()),
    );
  } finally {
    await disposeRuntimeFixture();
  }
});

function nativeState(
  patch: Partial<ExternalSessionState> = {},
): ExternalSessionState {
  return {
    activity: "idle",
    leafId: null,
    taskRuns: { instanceId: "receiver", activeRunId: null, settled: [] },
    modelSelection: { model: null, thinkingLevel: "off" },
    ...patch,
  };
}

function nativeFixture() {
  let state: ExternalSessionRead = nativeState();
  const native: ExternalSessionConnection = {
    read: vi.fn(async () => state),
    prompt: vi.fn(async () => {
      if (!("ended" in state)) state = { ...state, activity: "working" };
    }),
    rename: vi.fn(async (_name, beforeSend) => {
      beforeSend?.();
    }),
    abort: vi.fn(async () => {
      if (!("ended" in state)) state = { ...state, activity: "idle" };
    }),
    answerUi: vi.fn(async () => {}),
    models: vi.fn(async () => ({
      model: null,
      thinkingLevel: "off" as const,
      models: [],
    })),
    setModel: vi.fn(async () => ({
      model: null,
      thinkingLevel: "off" as const,
    })),
    setThinkingLevel: vi.fn(async () => ({
      model: null,
      thinkingLevel: "off" as const,
    })),
  };
  return {
    native,
    setState: (
      next:
        | Partial<ExternalSessionState>
        | Exclude<ExternalSessionRead, ExternalSessionState>,
    ) => {
      state = "ended" in next ? next : nativeState(next);
    },
  };
}

function branchMessage(id: string, parentId: string): string {
  return `${JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-11-10T15:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: id }] },
  })}\n`;
}

/** RuntimeExternalSessions driven directly on one idle slot "a". */
async function directAttachment(
  connect: ConnectExternalSession,
  host: Partial<ConstructorParameters<typeof RuntimeExternalSessions>[1]> = {},
  pollMs?: number,
) {
  const session = record("a", "/tmp");
  const projection = await preview(session, []);
  directProjections.push(projection);
  const slot = createRuntimeSlot({
    id: "a",
    cwd: session.cwd,
    sessionPath: session.path,
    process: null,
    preview: null,
    projection,
    bridge: null,
    branchRevision: 1,
    incarnationId: "slot-a",
    viewId: "view-a",
  });
  const external = new RuntimeExternalSessions(
    connect,
    {
      current: () => true,
      emit: vi.fn(),
      assertUsable: vi.fn(),
      released: vi.fn(),
      syncUi: vi.fn(),
      corresponds: () => true,
      continues: () => true,
      followLeaf: vi.fn(),
      renewView: vi.fn(),
      log: vi.fn(),
      reconcile: async () => {},
      ...host,
    },
    trackedAttachmentStore(),
    pollMs,
  );
  return { slot, external };
}

async function nativeModelFixture() {
  const f = nativeFixture();
  const selection = {
    model: { provider: "native", id: "current" },
    thinkingLevel: "low" as const,
  };
  const state = nativeState({
    modelSelection: selection,
    taskRuns: { instanceId: "receiver-one", activeRunId: null, settled: [] },
  });
  f.setState(state);
  f.native.models = vi.fn(async () => ({
    ...selection,
    models: [selection.model],
  }));
  f.native.setModel = vi.fn(async () => selection);
  f.native.setThinkingLevel = vi.fn(async () => selection);
  const emit = vi.fn();
  const { slot, external } = await directAttachment(
    async () => f.native,
    { emit },
    10,
  );
  return { ...f, selection, state, slot, external, emit };
}

function runtimeFor(
  sessions: SessionRecord[],
  options: RuntimeControllerOptions = {},
  store = trackedAttachmentStore(),
) {
  return new RuntimeController(catalog(sessions), store, {
    createProcess: () => {
      throw new Error("must not launch Pi");
    },
    ...options,
  });
}

/** A runtime over session "a" where a live Pi continues the branch. Owned
 * workers are refused unless a test supplies a factory. */
function attachedRuntime(
  connect: ConnectExternalSession,
  {
    createProcess,
    store,
  }: {
    createProcess?: RuntimeControllerOptions["createProcess"];
    store?: ReturnType<typeof trackedAttachmentStore>;
  } = {},
) {
  return runtimeFor(
    [record("a", "/tmp")],
    {
      ...(createProcess ? { createProcess } : {}),
      openSessionProjection: (session) => preview(session, []),
    },
    store,
  )
    .setExternalSessionPresence(async () => [null])
    .setExternalSessionConnector(async (id, file, match, idleOnly) =>
      idleOnly ? null : connect(id, file, match, idleOnly),
    );
}

/** Opening shows the live Pi read-only; Take over attaches to it. */
async function openAttached(runtime: RuntimeController, id: string) {
  await runtime.openSession(id);
  return runtime.takeOverSession(id);
}

describe("continue an externally owned Pi", () => {
  it("detects and stops live attached work before the next poll on restart", async () => {
    const session = await persistedRecord("a");
    const f = nativeFixture();
    f.setState({ activity: "idle", leafId: "u1" });
    const runtime = runtimeFor([session])
      .setExternalSessionPresence(async () => ["u1"])
      .setExternalSessionConnector(async () => f.native);
    const events: string[] = [];
    runtime.on("event", (event) => events.push(event.type));
    const dispatch = vi.fn();
    let startsAfterReservation = true;
    const controller = new HostRestartController(runtime, {
      inspect: async () => ({ host: true, all: true }),
      prepare: async () => {},
      request: async (all, commit) => {
        expect(all).toBe(true);
        const before = vi.mocked(f.native.read).mock.calls.length;
        if (startsAfterReservation) {
          // The TUI starts work after reservation while its last poll is idle.
          startsAfterReservation = false;
          f.setState({ activity: "working", leafId: "u1" });
        }
        if (await commit()) {
          dispatch();
          return { code: 0, issued: true };
        }
        expect(f.native.read).toHaveBeenCalledTimes(before + 1);
        expect(events).not.toContain("agent_start");
        return { code: 1, issued: false };
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await openAttached(runtime, "a");
      controller.start({
        hostId: (await controller.status()).hostId,
        operationId: "busy-before-commit",
        scope: "all",
      });
      await vi.waitFor(async () =>
        expect((await controller.status()).operation).toMatchObject({
          phase: "rejected",
          busyReason: "active-work",
          error: expect.stringContaining("Stop work and restart"),
        }),
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(f.native.abort).not.toHaveBeenCalled();
      expect(events).not.toContain("agent_start");
      const hostOnly = runtime.reserveMaintenanceRestart(false, false, true);
      if (hostOnly.kind !== "ready")
        throw new Error("Host-only restart blocked");
      runtime.releaseMaintenanceRestart(hostOnly.leaseId);
      controller.start({
        hostId: (await controller.status()).hostId,
        operationId: "forced-before-poll",
        scope: "all",
        interruptWork: true,
      });
      await vi.waitFor(async () =>
        expect((await controller.status()).operation).toMatchObject({
          id: "forced-before-poll",
          phase: "submitted",
        }),
      );
      expect(dispatch).toHaveBeenCalledOnce();
      expect(f.native.abort).toHaveBeenCalledExactlyOnceWith("u1");
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });

  it("identifies the attached session whose Stop could not be confirmed", async () => {
    const f = nativeFixture();
    f.setState({ activity: "working", leafId: null });
    vi.mocked(f.native.abort).mockRejectedValueOnce(
      new Error("No Stop receipt"),
    );
    const runtime = attachedRuntime(async () => f.native);
    trackRuntime(runtime);
    await openAttached(runtime, "a");
    await expect(runtime.stopAttachedPiWork()).rejects.toThrow(
      "Could not confirm Stop for a. Work may still be running.",
    );
  });

  it("requires a fresh observation for restart interruption and accepts an empty branch", async () => {
    const f = nativeFixture();
    f.setState({ activity: "working" });
    const { slot, external } = await directAttachment(async () => f.native);
    try {
      expect(await external.connect(slot)).toBe(true);
      vi.mocked(f.native.read).mockRejectedValueOnce(new Error("Unavailable"));
      await expect(external.abort(slot, true)).rejects.toThrow("Unavailable");
      expect(f.native.abort).not.toHaveBeenCalled();
      f.setState({ activity: "working", leafId: null });
      await external.abort(slot, true);
      expect(f.native.abort).toHaveBeenCalledExactlyOnceWith(null);
    } finally {
      external.close();
    }
  });

  it("loads a reported continuation and ends the attachment when Pi leaves its branch", async () => {
    const f = nativeFixture();
    const known = new Set(["current"]);
    const reconcile = vi.fn(async () => {
      known.add("continued");
    });
    const connect = vi.fn(async () => f.native);
    const onBranch = (_slot: RuntimeSlot, leaf: string | null) =>
      leaf !== null && known.has(leaf);
    const { slot, external } = await directAttachment(connect, {
      reconcile,
      corresponds: onBranch,
      continues: onBranch,
    });
    try {
      f.setState({ activity: "idle", leafId: "ancestor" });
      expect(await external.connect(slot)).toBe(false);
      f.setState({ activity: "idle", leafId: "current" });
      expect(await external.connect(slot)).toBe(true);

      known.delete("continued");
      reconcile.mockClear();
      const establishedConnections = connect.mock.calls.length;
      f.setState({ activity: "working", leafId: "continued" });
      expect(await external.connect(slot)).toBe(true);
      expect(reconcile).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledTimes(establishedConnections);

      f.setState({ activity: "idle", leafId: "sibling" });
      expect(await external.connect(slot)).toBe(false);
      expect(external.has(slot)).toBe(false);
    } finally {
      external.close();
    }
  });

  it("keeps a cold addressed view read-only when an apparently idle Pi is already working", async () => {
    const f = nativeFixture();
    f.setState({ activity: "working", leafId: "u1" });
    const createProcess = vi.fn(() => {
      throw new Error("must not launch Pi");
    });
    const runtime = runtimeFor([await persistedRecord("a")], { createProcess })
      .setExternalSessionPresence(async () => ["u1"])
      .setExternalSessionConnector(async (_id, _file, _match, idleOnly) =>
        idleOnly ? f.native : null,
      );
    const release = runtime.retainSessionView("a");
    try {
      const { active } = await runtime.snapshot("a");
      expect(active?.readOnlyReason).toBe("external-active");
      expect(runtime.activeSessionId).toBeNull();
      await expect(
        runtime.prompt({ sessionId: "a", message: "First input" }),
      ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });
      await expect(
        runtime.setModel("a", "test", "model"),
      ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });
      expect(createProcess).not.toHaveBeenCalled();
      expect(f.native.prompt).not.toHaveBeenCalled();
      expect(f.native.setModel).not.toHaveBeenCalled();
    } finally {
      release();
      await runtime.close();
    }
  });

  it("opens the current branch when the live Pi confirms it is still on an older node", async () => {
    const session = await persistedRecord("a");
    await appendFile(session.path, branchMessage("saved-current", "u1"));
    const create = vi.fn(
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
    );
    const runtime = runtimeFor([session], {
      createProcess: create,
    }).setExternalSessionPresence(async (_id, _file, _fresh, isAncestor) => {
      expect(isAncestor("u1")).toBe(true);
      return ["u1"];
    });
    trackRuntime(runtime);
    const preview = await runtime.openSession("a");
    expect(preview.active?.effectiveLeafId).toBe("saved-current");
    await waitForReady(runtime);
    expect(create).toHaveBeenCalledOnce();
    const snapshot = await runtime.snapshot("a");
    expect(snapshot.active?.readOnlyReason).toBeUndefined();
    expect(snapshot.active?.effectiveLeafId).toBe("saved-current");
  });

  it.each([null, undefined])(
    "keeps a live Pi with unavailable attachment and leaf %s read-only",
    async (leaf) => {
      const presence = vi.fn(async () => [leaf]);
      const connect = vi.fn(async () => null);
      const create = vi.fn(
        (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      );
      const runtime = attachedRuntime(connect, {
        createProcess: create,
      }).setExternalSessionPresence(presence);
      const release = runtime.retainSessionView("a");
      try {
        await expect(runtime.takeOverSession("a")).rejects.toMatchObject({
          code: "EXTERNAL_PI_WRITER_ACTIVE",
        });
        expect(presence).toHaveBeenCalledWith(
          "a",
          expect.any(String),
          true,
          expect.any(Function),
        );
        expect(connect).toHaveBeenCalledOnce();
        expect(create).not.toHaveBeenCalled();
        expect((await runtime.snapshot("a")).active?.readOnlyReason).toBe(
          "external-active",
        );
      } finally {
        release();
        await runtime.close();
      }
    },
  );

  it("does not start a writer when live ownership could not be observed", async () => {
    const create = vi.fn(
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
    );
    const runtime = attachedRuntime(async () => null, {
      createProcess: create,
    }).setExternalSessionPresence(async () => {
      throw new Error("Cannot read registry");
    });
    trackRuntime(runtime);
    await runtime.snapshot("a");
    await expect(
      runtime.prompt({ sessionId: "a", message: "First input" }),
    ).rejects.toMatchObject({ code: "EXTERNAL_PI_PRESENCE_UNAVAILABLE" });
    expect(create).not.toHaveBeenCalled();
  });

  it("fences a new external leaf reported during writer preparation", async () => {
    const workers: FakeRpc[] = [];
    const runtime = attachedRuntime(async () => null, {
      createProcess: (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
    }).setExternalSessionPresence(
      vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValue(["not-yet-projected"]),
    );
    const release = runtime.retainSessionView("a");
    try {
      await runtime.snapshot("a");
      await expect(
        runtime.prompt({ sessionId: "a", message: "First input" }),
      ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });
      expect(workers).toHaveLength(1);
      expect(workers[0]!.starts).toBe(0);
    } finally {
      release();
      await runtime.close();
    }
  });

  it("rechecks a merely viewed session on entry but keeps a worked-on session editable", async () => {
    let live: (string | null)[] = [];
    const workers: FakeRpc[] = [];
    const runtime = runtimeFor([record("a", "/tmp"), record("b", "/tmp")], {
      createProcess: (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      openSessionProjection: (session) => preview(session, []),
    })
      .setExternalSessionPresence(async () => live)
      .setExternalSessionConnector(async () => null);
    trackRuntime(runtime);
    // Both warm a worker; only "b" receives input.
    await runtime.openSession("a");
    await waitForReady(runtime, "a");
    await runtime.openSession("b");
    await waitForReady(runtime, "b");
    await runtime.prompt({ sessionId: "b", message: "working here" });
    live = [null];
    await runtime.openSession("a");
    await vi.waitFor(async () =>
      expect((await runtime.snapshot("a")).active?.readOnlyReason).toBe(
        "external-active",
      ),
    );
    expect(workers[0]!.stops).toBe(1);
    await runtime.openSession("b");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (await runtime.snapshot("b")).active?.readOnlyReason,
    ).toBeUndefined();
    expect(workers[1]!.stops).toBe(0);
  });

  it("observes short native run outcomes without replaying the initial report or claiming idle means success", async () => {
    const f = nativeFixture();
    const old = {
      id: "old",
      outcome: "completed" as const,
      settledAt: Date.now(),
    };
    const runs = { instanceId: "receiver", activeRunId: null, settled: [old] };
    f.setState({ activity: "idle", taskRuns: runs });
    const runtime = attachedRuntime(async () => f.native);
    const events: Record<string, unknown>[] = [];
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );
    trackRuntime(runtime);
    await openAttached(runtime, "a");
    expect(
      events.filter((event) => event.type === "native_task_outcome"),
    ).toEqual([]);
    const failed = {
      id: "new",
      outcome: "failed" as const,
      settledAt: Date.now(),
    };
    f.setState({
      activity: "idle",
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
  });

  it("retries an unavailable takeover and keeps it through a later transient read failure", async () => {
    const f = nativeFixture();
    const runtime = attachedRuntime(async () => f.native);
    const read = vi.mocked(f.native.read);
    trackRuntime(runtime);
    read.mockRejectedValue(new Error("Control endpoint unavailable"));
    await expect(openAttached(runtime, "a")).rejects.toThrow(
      "Control endpoint unavailable",
    );
    expect((await runtime.snapshot("a")).active?.readOnlyReason).toBe(
      "external-active",
    );

    read.mockResolvedValue(nativeState());
    await runtime.takeOverSession("a");
    read.mockRejectedValue(new Error("reloading"));
    const reads = read.mock.calls.length;
    await vi.waitFor(
      () => expect(read.mock.calls.length).toBeGreaterThan(reads),
      {
        timeout: 2_000,
      },
    );
    expect(
      (await runtime.snapshot("a")).active?.readOnlyReason,
    ).toBeUndefined();

    read.mockResolvedValue(nativeState());
    await runtime.prompt({ sessionId: "a", message: "Still attached" });
    expect(f.native.prompt).toHaveBeenCalledOnce();
  });

  it("keeps an in-flight send and its Stop addressed to the attached Pi after switching sessions", async () => {
    const f = nativeFixture();
    f.setState({ leafId: "u1" });
    const entered = deferredSignal();
    const deliver = deferredSignal();
    const nativePrompt = vi.mocked(f.native.prompt);
    nativePrompt.mockImplementation(async (_message, _behavior, beforeSend) => {
      entered.resolve();
      await deliver.promise;
      beforeSend?.();
      f.setState({ activity: "working", leafId: "u1" });
    });
    const workers: FakeRpc[] = [];
    const runtime = runtimeFor(
      [await persistedRecord("a"), await persistedRecord("b")],
      {
        createProcess: (options) => {
          const worker = new FakeRpc(options);
          workers.push(worker);
          return worker as unknown as PiRpcProcess;
        },
      },
    )
      .setExternalSessionPresence(async (id) => (id === "a" ? ["u1"] : []))
      .setExternalSessionConnector(async (id) =>
        id === "a" ? f.native : null,
      );
    const settled = vi.fn();
    runtime.on("event", (event) => {
      if (event.type === "agent_settled") settled(event);
    });
    try {
      await runtime.openSession("a");
      await vi.waitFor(async () => {
        const snapshot = await runtime.snapshot("a");
        expect(snapshot.active?.readOnlyReason).toBeUndefined();
        expect(snapshot.sessionStatuses.a?.external).toBe(true);
      });
      const sending = runtime.prompt({ sessionId: "a", message: "For A only" });
      await entered.promise;
      await runtime.openSession("b");
      deliver.resolve();
      await sending;
      expect(nativePrompt.mock.calls.map(([message]) => message)).toEqual([
        "For A only",
      ]);
      await waitForReady(runtime, "b");
      expect(workers.map((worker) => worker.sessionId)).toEqual(["b"]);

      await vi.waitFor(async () =>
        expect((await runtime.snapshot("b")).sessionStatuses.a?.runState).toBe(
          "running",
        ),
      );
      settled.mockClear();
      await runtime.abort("a");
      await vi.waitFor(() =>
        expect(settled).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: "a" }),
        ),
      );
      expect(f.native.abort).toHaveBeenCalledExactlyOnceWith("u1");
      expect(runtime.activeSessionId).toBe("b");
    } finally {
      deliver.resolve();
      await runtime.close();
    }
  });

  it.each(["prompt", "rename", "setModel", "setThinkingLevel"] as const)(
    "does not retarget %s from a retired attachment",
    async (action) => {
      const first = nativeFixture();
      const replacement = nativeFixture();
      const connect = vi
        .fn()
        .mockResolvedValueOnce(first.native)
        .mockResolvedValue(replacement.native);
      const create = vi.fn(
        (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      );
      const runtime = attachedRuntime(connect, { createProcess: create });
      trackRuntime(runtime);
      await openAttached(runtime, "a");
      first.setState({ ended: "exited" });
      const mutate = {
        prompt: () =>
          runtime.prompt({ sessionId: "a", message: "Original Pi" }),
        rename: () => runtime.rename("a", "Original Pi"),
        setModel: () => runtime.setModel("a", "native", "model"),
        setThinkingLevel: () => runtime.setThinkingLevel("a", "high"),
      };
      await expect(mutate[action]()).rejects.toMatchObject({ status: 409 });
      expect(connect).toHaveBeenCalledOnce();
      expect(create).not.toHaveBeenCalled();
      expect(first.native[action]).not.toHaveBeenCalled();
      expect(replacement.native[action]).not.toHaveBeenCalled();
    },
  );

  it("rejects input for a cold view superseded by a pending branch selection", async () => {
    const session = await persistedRecord("a");
    await appendFile(session.path, branchMessage("old-branch", "u1"));
    const scanning = deferredSignal();
    const finish = deferredSignal();
    let pause = false;
    const workers: FakeRpc[] = [];
    const runtime = runtimeFor([session], {
      createProcess: (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
    })
      .setExternalSessionPresence(async () => {
        if (pause) {
          pause = false;
          scanning.resolve();
          await finish.promise;
        }
        return ["old-branch"];
      })
      .setExternalSessionConnector(async () => null);
    const release = runtime.retainSessionView("a");
    try {
      await runtime.openSession("a");
      await vi.waitFor(async () =>
        expect((await runtime.snapshot("a")).active?.readOnlyReason).toBe(
          "external-active",
        ),
      );
      await appendFile(session.path, branchMessage("other-branch", "u1"));
      const oldView = (await runtime.snapshot("a")).active!;
      expect(oldView.effectiveLeafId).toBe("old-branch");
      pause = true;
      const select = runtime.selectBranch("a", "other-branch");
      await scanning.promise;
      const send = expect(
        runtime.prompt({ sessionId: "a", message: "For old branch" }),
      ).rejects.toMatchObject({ code: "PROMPT_VIEW_CHANGED" });
      finish.resolve();
      await Promise.all([select, send]);
      await expect(
        runtime.prompt({
          sessionId: "a",
          expectedViewId: oldView.transcriptPage!.viewId,
          message: "For old branch",
        }),
      ).rejects.toMatchObject({ code: "PROMPT_VIEW_CHANGED" });
      expect((await runtime.snapshot("a")).active?.effectiveLeafId).toBe(
        "other-branch",
      );
      expect(workers).toHaveLength(1);
      expect(workers[0]!.commands).not.toContainEqual({
        type: "prompt",
        message: "For old branch",
      });
    } finally {
      finish.resolve();
      release();
      await runtime.close();
    }
  });

  it("keeps recalled input bound to an attached branch even when another branch becomes the default", async () => {
    const session = await persistedRecord("a");
    await appendFile(
      session.path,
      branchMessage("other", "u1") + branchMessage("chosen", "u1"),
    );
    const f = nativeFixture();
    f.setState({ activity: "working", leafId: "chosen" });
    let live = true;
    const { runtime, workers } = fakeRuntime({
      sessions: [session],
      configure(worker) {
        worker.failPrompts = true;
      },
    });
    runtime
      .setExternalSessionPresence(async () => (live ? ["chosen"] : []))
      .setExternalSessionConnector(async (_id, _file, _match, idleOnly) =>
        idleOnly ? null : f.native,
      );
    trackRuntime(runtime);
    await openAttached(runtime, "a");
    await expect(runtime.selectBranch("a", "other")).rejects.toMatchObject({
      status: 409,
    });
    expect(await runtime.snapshot("a")).toMatchObject({
      sessionStatuses: { a: { external: true } },
      runState: "running",
      active: { effectiveLeafId: "chosen" },
    });

    f.setState({ activity: "idle", leafId: "chosen" });
    await appendFile(session.path, branchMessage("other-tip", "other"));
    const { active } = await runtime.snapshot("a");
    expect(active).toMatchObject({
      effectiveLeafId: "chosen",
      durableLeafId: "other-tip",
    });
    const { viewId, incarnation } = active!.transcriptPage;
    await runtime.prompt({
      sessionId: "a",
      message: "Recall from attached view",
      historyArtifacts: {
        viewId: viewId!,
        incarnation: incarnation!,
        effectiveLeafId: "chosen",
        imageReferences: [],
        fileReferences: [],
      },
    });
    expect(f.native.prompt).toHaveBeenCalledOnce();

    f.setState({ ended: "exited" });
    live = false;
    const send = () =>
      runtime.prompt({ sessionId: "a", message: "For chosen branch" });
    await expect(send()).rejects.toThrow(
      "The external Pi connection has ended",
    );
    await expect(send()).rejects.toThrow("prompt rejected");
    expect(workers).toHaveLength(1);
    expect(workers[0]!.stops).toBeGreaterThan(0);
    expect(workers[0]!.commands).not.toContainEqual({
      type: "prompt",
      message: "For chosen branch",
    });
    expect((await runtime.snapshot("a")).active).toMatchObject({
      effectiveLeafId: "chosen",
      durableLeafId: "other-tip",
    });
  });

  it("discards late native state after retirement and completes writer recovery", async () => {
    const f = nativeFixture();
    const entered = deferredSignal();
    const proceed = deferredSignal();
    let retired = false;
    const worker = vi.fn(
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
    );
    const runtime = attachedRuntime(async () => (retired ? null : f.native), {
      createProcess: worker,
    }).setExternalSessionPresence(async () => (retired ? [] : [null]));
    const events: Array<{ type: string }> = [];
    runtime.on("event", (event) => events.push(event));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      runtime.retainSessionView("a");
      await openAttached(runtime, "a");
      await vi.waitFor(async () =>
        expect((await runtime.snapshot("a")).sessionStatuses.a?.external).toBe(
          true,
        ),
      );
      vi.mocked(f.native.read).mockImplementationOnce(async () => {
        entered.resolve();
        await proceed.promise;
        return nativeState({ activity: "working" });
      });
      await runtime.openSession("a");
      await entered.promise;
      retired = true;
      f.setState({ ended: "exited" });
      await vi.advanceTimersByTimeAsync(750);
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

  it("follows a Pi that reports its new leaf after the append was already read", async () => {
    const session = await persistedRecord("a");
    const f = nativeFixture();
    f.setState({ activity: "working", leafId: "u1" });
    const runtime = runtimeFor([session])
      .setExternalSessionPresence(async () => ["u1"])
      .setExternalSessionConnector(async (_id, _file, _match, idleOnly) =>
        idleOnly ? null : f.native,
      );
    const events: Array<{ type: string; sessionId: string }> = [];
    runtime.on("event", (event) => events.push(event));
    trackRuntime(runtime);
    const attached = await openAttached(runtime, "a");
    expect(attached.sessionStatuses.a?.external).toBe(true);
    const replyId = "native-reply";
    await appendFile(session.path, branchMessage(replyId, "u1"));
    const saved = await runtime.snapshot("a");
    expect(saved.active?.durableLeafId).toBe(replyId);
    expect(saved.active?.projectionConflict).toBeNull();

    events.length = 0;
    f.setState({ activity: "working", leafId: replyId });
    await vi.waitFor(
      () =>
        expect(events).toContainEqual(
          expect.objectContaining({
            sessionId: "a",
            type: "session_projection_changed",
          }),
        ),
      { timeout: 2_000 },
    );
    const { active } = await runtime.snapshot("a");
    expect(active?.effectiveLeafId).toBe(replyId);
    expect(active?.transcriptPage.viewId).toBe(
      saved.active?.transcriptPage.viewId,
    );
    expect(active?.transcriptPage.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ __inspireEntryId: replyId }),
      ]),
    );
  });

  it("keeps attached-prompt bytes for retry after refusal or a lost receipt, then retires transport images", async () => {
    const f = nativeFixture();
    const store = trackedAttachmentStore();
    const prompt = vi.mocked(f.native.prompt);
    const runtime = attachedRuntime(async () => f.native, { store });
    const imageUpload = upload("image.png", "image/png");
    const fileUpload = upload("notes.txt", "text/plain");
    const payload = imageUpload.buffer;
    try {
      await openAttached(runtime, "a");
      const image = await store.add(imageUpload);
      const file = await store.add(fileUpload);
      const request = {
        sessionId: "a",
        message: "Read this",
        attachmentIds: [image.id, file.id],
      };
      prompt.mockImplementationOnce(
        async (text, _behavior, _before, images) => {
          expect(text).toBe("");
          expect(images).toHaveLength(1);
          expect(await readFile(images![0]!.path)).toEqual(payload);
          throw new Error("Native question is waiting");
        },
      );
      await expect(
        runtime.prompt({
          ...request,
          message: "",
          attachmentIds: [image.id],
        }),
      ).rejects.toThrow("Native question");
      expect((await store.imagePreview(image.id)).bytes).toEqual(payload);
      await runtime.prompt(request);
      const [message, , , images] = prompt.mock.lastCall!;
      expect(images).toEqual([
        expect.objectContaining({ mimeType: "image/png" }),
      ]);
      const acceptedFile = parseAttachmentContext(message, 1).references[0]!;
      expect(await readFile(acceptedFile)).toEqual(fileUpload.buffer);
      await expect(store.imagePreview(image.id)).rejects.toMatchObject({
        status: 404,
      });

      f.setState({ activity: "idle" });
      const retryImage = await store.add(imageUpload);
      const retryFile = await store.add(fileUpload);
      const attachmentIds = [retryImage.id, retryFile.id];
      prompt.mockRejectedValueOnce(
        Object.assign(new Error("Receipt lost"), { outcomeUnknown: true }),
      );
      await expect(
        runtime.prompt({ ...request, attachmentIds }),
      ).rejects.toMatchObject({
        outcomeUnknown: true,
      });
      const [uncertainMessage, , , uncertainImages] = prompt.mock.lastCall!;
      const imagePath = uncertainImages![0]!.path;
      const filePath = parseAttachmentContext(uncertainMessage, 1)
        .references[0]!;
      expect((await store.imagePreview(retryImage.id)).bytes).toEqual(payload);
      store.restage(attachmentIds);
      await store.remove(retryImage.id);
      await store.remove(retryFile.id);
      expect(await readFile(imagePath)).toEqual(payload);
      expect(store.ownsPromptFile(filePath)).toBe(true);
      expect((await store.collectStaged()).reclaimed).not.toContain(imagePath);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.advanceTimersByTime(6 * 60_000);
      await expect(store.collectStaged()).resolves.toMatchObject({
        reclaimed: [imagePath],
      });
      await expect(readFile(imagePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(filePath)).toEqual(fileUpload.buffer);
    } finally {
      vi.useRealTimers();
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
    const runtime = attachedRuntime(async () => f.native);
    try {
      await openAttached(runtime, "a");
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

  it.each(["prompt", "abort"] as const)(
    "ends an in-flight native %s before moving its session",
    async (operation) => {
      const f = nativeFixture();
      f.setState({ activity: "idle", leafId: "u1" });
      const entered = deferredSignal();
      const gate = deferredSignal();
      const terminated = vi.fn(async () => {
        gate.resolve();
      });
      const hold = async () => {
        entered.resolve();
        await gate.promise;
      };
      if (operation === "abort")
        vi.mocked(f.native.abort).mockImplementation(hold);
      else vi.mocked(f.native.prompt).mockImplementation(hold);
      const remove = vi.fn(async () => "trashed" as const);
      const runtime = runtimeFor([await persistedRecord("a")], {
        branchBridgeTimeoutMs: 15_000,
        deleteSessionRecord: remove,
      })
        .setExternalSessionPresence(async () => [null])
        .setExternalSessionConnector(async () => f.native);
      try {
        await openAttached(runtime, "a");
        await vi.waitFor(() => expect(f.native.read).toHaveBeenCalled());
        const sending =
          operation === "prompt"
            ? runtime.prompt({ sessionId: "a", message: "Hold" })
            : runtime.abort("a");
        await entered.promise;
        expect(runtime.reserveMaintenanceRestart()).toMatchObject({
          kind: "busy",
        });
        runtime.setExternalSessionTerminator(terminated);
        await runtime.deleteSession("a");
        await sending;
        expect(terminated).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
        await runtime.close();
      }
    },
  );

  it.each(["catalog", "poll", "reselect"] as const)(
    "preserves completed model and thinking changes over an older %s read",
    async (source) => {
      const f = await nativeModelFixture();
      const gate = deferredSignal();
      const selected = {
        model: { provider: "native", id: "selected" },
        thinkingLevel: "high" as const,
      };
      const models = [f.selection.model, selected.model];
      vi.mocked(f.native.setModel).mockResolvedValue({
        ...selected,
        thinkingLevel: "low",
      });
      vi.mocked(f.native.setThinkingLevel).mockResolvedValue(selected);
      vi.useFakeTimers();
      try {
        await f.external.connect(f.slot);
        let reading: Promise<unknown> | undefined;
        if (source === "catalog") {
          vi.mocked(f.native.models).mockImplementationOnce(async () => {
            await gate.promise;
            return { ...f.selection, models };
          });
          reading = f.external.models(f.slot);
        } else {
          vi.mocked(f.native.read).mockImplementationOnce(async () => {
            await gate.promise;
            return { ...f.state, activity: "working" };
          });
          if (source === "reselect") reading = f.external.connect(f.slot);
          else await vi.advanceTimersByTimeAsync(10);
          expect(f.native.read).toHaveBeenCalledTimes(2);
        }

        await f.external.setModel(f.slot, "native", "selected");
        await f.external.setThinkingLevel(f.slot, "high");
        gate.resolve();
        const response = await reading;
        await vi.advanceTimersByTimeAsync(0);
        expect(f.external.modelSelection(f.slot)).toEqual(selected);
        if (source === "catalog") {
          expect(response).toEqual({ ...selected, models });
          expect(f.slot.availableModels).toEqual(models);
        } else {
          expect(f.slot.runState).toBe("running");
          // A subsequent terminal-side selection remains authoritative.
          await vi.advanceTimersByTimeAsync(10);
          expect(f.external.modelSelection(f.slot)).toEqual(f.selection);
        }
      } finally {
        gate.resolve();
        f.external.close();
        vi.useRealTimers();
      }
    },
  );

  it.each(["model", "thinking"] as const)(
    "preserves a confirmed same-value %s selection over an older catalog result",
    async (kind) => {
      const f = await nativeModelFixture();
      const gate = deferredSignal();
      const old = {
        model: { provider: "native", id: "stale" },
        thinkingLevel: "off" as const,
      };
      vi.mocked(f.native.models).mockImplementationOnce(async () => {
        await gate.promise;
        return { ...old, models: [old.model, f.selection.model] };
      });
      vi.useFakeTimers();
      try {
        await f.external.connect(f.slot);
        const reading = f.external.models(f.slot);
        if (kind === "model")
          await f.external.setModel(f.slot, "native", "current");
        else await f.external.setThinkingLevel(f.slot, "low");
        gate.resolve();
        expect(await reading).toMatchObject(f.selection);
        expect(f.external.modelSelection(f.slot)).toEqual(f.selection);
      } finally {
        gate.resolve();
        f.external.close();
        vi.useRealTimers();
      }
    },
  );

  it("retires in-flight catalog and selection replies when Pi reloads its receiver", async () => {
    const f = await nativeModelFixture();
    const gate = deferredSignal();
    const successor = {
      model: { provider: "native", id: "successor" },
      thinkingLevel: "high" as const,
    };
    const oldModel = { provider: "old", id: "retired" };
    const freshModel = { provider: "fresh", id: "available" };
    const late = async () => {
      await gate.promise;
      return f.selection;
    };
    vi.mocked(f.native.models)
      .mockImplementationOnce(async () => ({
        ...(await late()),
        models: [oldModel],
      }))
      .mockResolvedValue({ ...successor, models: [freshModel] });
    vi.mocked(f.native.setModel).mockImplementationOnce(late);
    vi.mocked(f.native.setThinkingLevel).mockImplementationOnce(late);
    vi.useFakeTimers();
    try {
      await f.external.connect(f.slot);
      const outcomes = Promise.allSettled([
        f.external.models(f.slot),
        f.external.setModel(f.slot, "native", "current"),
        f.external.setThinkingLevel(f.slot, "low"),
      ]);
      f.emit.mockClear();
      f.setState({
        ...f.state,
        modelSelection: successor,
        taskRuns: { ...f.state.taskRuns, instanceId: "receiver-two" },
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(f.slot.availableModels).toBeNull();
      expect(f.emit).toHaveBeenCalledWith(f.slot, {
        type: "model_metadata_changed",
      });
      // The replacement's read can finish without waiting for the old reply.
      await expect(f.external.models(f.slot)).resolves.toMatchObject({
        ...successor,
        models: [freshModel],
      });
      gate.resolve();
      for (const result of await outcomes)
        expect(result).toMatchObject({
          status: "rejected",
          reason: { status: 409 },
        });
      expect(f.slot.availableModels).toEqual([freshModel]);
      expect(f.external.modelSelection(f.slot)).toEqual(successor);
    } finally {
      gate.resolve();
      f.external.close();
      vi.useRealTimers();
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
      f.setState({ activity: "idle" });
      f.native.setModel = vi.fn();
      f.native.setThinkingLevel = vi.fn();
    }
    old.native.models = vi.fn(async () => {
      await gate.promise;
      return catalogFor("old");
    });
    fresh.native.models = vi.fn(async () => catalogFor("fresh"));
    const emit = vi.fn();
    const { slot, external } = await directAttachment(
      vi.fn().mockResolvedValueOnce(old.native).mockResolvedValue(fresh.native),
      { emit },
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
    const log = vi.fn();
    const reconcile = vi.fn(async (): Promise<unknown> => {
      throw new Error("Projection read failed");
    });
    const { slot, external } = await directAttachment(
      async () => f.native,
      { log, reconcile },
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

  it.each([
    ["unreachable", { ended: "unreachable" }, true],
    ["left-branch", { activity: "working", leafId: "elsewhere" }, false],
  ] as const)(
    "ends a busy attachment that %s without claiming its task failed",
    async (reason, observed, stillOnBranch) => {
      const f = nativeFixture();
      const emit = vi.fn();
      let onBranch = true;
      const released = vi.fn();
      const { slot, external } = await directAttachment(
        async () => f.native,
        {
          emit,
          released,
          corresponds: () => onBranch,
        },
        10,
      );
      vi.useFakeTimers();
      try {
        f.setState({ activity: "working" });
        await external.connect(slot);
        expect(slot.runState).toBe("running");
        f.setState(observed);
        onBranch = stillOnBranch;
        await vi.advanceTimersByTimeAsync(20);
        expect(external.has(slot)).toBe(false);
        expect(slot.runState).toBe("idle");
        expect(emit).toHaveBeenCalledWith(slot, {
          type: "external_attachment_ended",
          reason,
          duringWork: true,
        });
        expect(emit).not.toHaveBeenCalledWith(
          slot,
          expect.objectContaining({ type: "runtime_error" }),
        );
        expect(released).toHaveBeenCalledWith(slot);
      } finally {
        external.close();
        vi.useRealTimers();
      }
    },
  );

  it("rediscovers an ended native owner on a subsequent open without repeating input", async () => {
    const first = nativeFixture();
    const next = nativeFixture();
    const connect = vi
      .fn()
      .mockResolvedValueOnce(first.native)
      .mockResolvedValue(next.native);
    const runtime = attachedRuntime(connect);
    trackRuntime(runtime);
    await openAttached(runtime, "a");
    await runtime.prompt({ sessionId: "a", message: "First" });
    first.setState({ ended: "exited" });
    await vi.waitFor(
      async () =>
        expect(
          (await runtime.snapshot("a")).sessionStatuses.a?.external,
        ).not.toBe(true),
      { timeout: 1_500 },
    );
    await openAttached(runtime, "a");
    await runtime.prompt({ sessionId: "a", message: "Fresh" });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.native.prompt).toHaveBeenCalledTimes(1);
    expect(next.native.prompt).toHaveBeenCalledExactlyOnceWith(
      "Fresh",
      undefined,
      expect.any(Function),
      undefined,
      null,
    );
  });

  it("discards a takeover that resolves after Host shutdown", async () => {
    const f = nativeFixture();
    const gate = deferredSignal();
    const connect = vi.fn(async () => {
      await gate.promise;
      return f.native;
    });
    const runtime = attachedRuntime(connect);
    const taking = openAttached(runtime, "a").catch(() => undefined);
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    const closing = runtime.close();
    gate.resolve();
    await closing;
    await taking;
    expect(f.native.read).not.toHaveBeenCalled();
    expect(f.native.prompt).not.toHaveBeenCalled();
  });
});
