import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectExternalSession,
  ExternalSessionConnection,
  ExternalSessionRead,
  ExternalSessionState,
} from "../../server/external-session.js";
import { HostRestartController } from "../../server/host-restart.js";
import type { PiRpcOptions, PiRpcProcess } from "../../server/pi-rpc.js";
import {
  RuntimeController,
  type RuntimeControllerOptions,
} from "../../server/runtime.js";
import { RuntimeExternalSessions } from "../../server/runtime-external-sessions.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import { createRuntimeSlot } from "../../server/runtime-slot.js";
import {
  SessionCatalog,
  type SessionRecord,
} from "../../server/session-catalog.js";
import { parseAttachmentContext } from "../../shared/attachment-context.js";
import {
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  fixtureWorkspace,
  initializeRuntimeFixture,
  persistedRecord,
  preview,
  record,
  startWorker,
  trackedAttachmentStore,
  trackRuntime,
  upload,
} from "./fixtures/runtime.js";
import { jsonl, messageEntry } from "./fixtures/session-jsonl.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";

const directlyAttached: Array<{
  external: RuntimeExternalSessions;
  projection: Awaited<ReturnType<typeof preview>>;
}> = [];

beforeEach(async () => {
  await initializeRuntimeFixture();
  const pi = await nativePiWorkspace(
    "pi-",
    { defaultProjectTrust: "never" },
    fixtureWorkspace,
  );
  stubNativePiEnvironment(pi.env);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", fixtureWorkspace);
});
afterEach(async () => {
  try {
    for (const { external, projection } of directlyAttached.splice(0)) {
      external.close();
      await projection.close();
    }
    await disposeRuntimeFixture();
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

function nativeState(
  patch: Partial<ExternalSessionState> = {},
): ExternalSessionState {
  return {
    activity: "idle",
    leafId: null,
    taskRuns: { instanceId: "receiver", settled: [] },
    modelSelection: { model: null, thinkingLevel: "off" },
    ...patch,
  };
}

function nativeFixture(initial?: Partial<ExternalSessionState>) {
  let state: ExternalSessionRead = nativeState(initial);
  const selection = { model: null, thinkingLevel: "off" as const };
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
    models: vi.fn(async () => ({ ...selection, models: [] })),
    setModel: vi.fn(async () => selection),
    setThinkingLevel: vi.fn(async () => selection),
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

const branchMessage = (id: string, parentId: string) =>
  jsonl(
    messageEntry(id, parentId, {
      role: "assistant",
      content: [{ type: "text", text: id }],
      timestamp: Date.parse("2026-11-10T15:00:00.000Z"),
    }),
  );

function workerFactory(configure?: (worker: FakeRpc) => void) {
  const workers: FakeRpc[] = [];
  const createProcess = vi.fn((options: PiRpcOptions) => {
    const worker = new FakeRpc(options);
    configure?.(worker);
    workers.push(worker);
    return worker as unknown as PiRpcProcess;
  });
  return { workers, createProcess };
}

/** RuntimeExternalSessions driven directly on one idle slot "a". */
async function directAttachment(
  connect: ConnectExternalSession,
  host: Partial<ConstructorParameters<typeof RuntimeExternalSessions>[1]> = {},
) {
  const session = record("a", "/tmp");
  const projection = await preview(session, []);
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
  const emit = vi.fn();
  const taskOutcome = vi.fn();
  const released = vi.fn();
  const log = vi.fn();
  const external = new RuntimeExternalSessions(
    connect,
    {
      current: () => true,
      emit,
      taskOutcome,
      assertUsable: vi.fn(),
      released,
      corresponds: () => true,
      continues: () => true,
      followLeaf: vi.fn(),
      renewView: vi.fn(),
      log,
      reconcile: async () => {},
      ...host,
    },
    trackedAttachmentStore(),
    10,
  );
  directlyAttached.push({ external, projection });
  return { slot, external, emit, taskOutcome, released, log };
}

async function nativeModelFixture() {
  const selection = {
    model: { provider: "native", id: "current" },
    thinkingLevel: "low" as const,
  };
  const state = nativeState({
    modelSelection: selection,
    taskRuns: { instanceId: "receiver-one", settled: [] },
  });
  const f = nativeFixture(state);
  const replacement = nativeFixture();
  let current = f.native;
  f.native.models = vi.fn(async () => ({
    ...selection,
    models: [selection.model],
  }));
  f.native.setModel = vi.fn(async () => selection);
  f.native.setThinkingLevel = vi.fn(async () => selection);
  const owner = await directAttachment(async () => current);
  await owner.external.connect(owner.slot);
  return {
    ...f,
    ...owner,
    selection,
    state,
    replacement,
    replace: async () => {
      owner.external.detach(owner.slot);
      current = replacement.native;
      await owner.external.connect(owner.slot);
    },
  };
}

function runtimeFor(
  session: SessionRecord,
  options: RuntimeControllerOptions = {},
  store = trackedAttachmentStore(),
) {
  const runtime = new RuntimeController(
    new SessionCatalog(session.cwd),
    store,
    {
      createProcess: () => {
        throw new Error("Unexpected Pi startup");
      },
      ...options,
    },
  );
  trackRuntime(runtime);
  return runtime;
}

/** A native session with an empty leaf, attached only after explicit takeover. */
async function attachedRuntime(
  connect: ConnectExternalSession,
  {
    createProcess,
    store,
  }: {
    createProcess?: RuntimeControllerOptions["createProcess"];
    store?: ReturnType<typeof trackedAttachmentStore>;
  } = {},
) {
  const session = record("a", fixtureWorkspace);
  await (await preview(session, [])).close();
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(fixtureWorkspace, "previews"));
  return runtimeFor(
    session,
    { ...(createProcess ? { createProcess } : {}) },
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
    const runtime = runtimeFor(session)
      .setExternalSessionPresence(async () => ["u1"])
      .setExternalSessionConnector(async () => f.native);
    const events: string[] = [];
    runtime.on("event", (event) => events.push(event.type));
    const dispatch = vi.fn();
    let startsAfterReservation = true;
    const controller = new HostRestartController(runtime, {
      inspect: async () => ({ host: true }),
      prepare: async () => {},
      request: async (scope, commit) => {
        expect(scope).toBe("host");
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
        scope: "host",
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
      controller.start({
        hostId: (await controller.status()).hostId,
        operationId: "forced-before-poll",
        scope: "host",
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
      vi.useRealTimers();
    }
  });

  it("reports unconfirmed Stop and refreshes the receiver before retrying on an empty branch", async () => {
    const f = nativeFixture();
    f.setState({ activity: "working" });
    const runtime = await attachedRuntime(async () => f.native);
    await openAttached(runtime, "a");
    const stop = () =>
      expect(runtime.stopAttachedPiWork()).rejects.toThrow(
        "Could not confirm Stop for a. Work may still be running.",
      );
    vi.mocked(f.native.read).mockRejectedValueOnce(new Error("Unavailable"));
    await stop();
    expect(f.native.abort).not.toHaveBeenCalled();
    vi.mocked(f.native.abort).mockRejectedValueOnce(
      new Error("No Stop receipt"),
    );
    await stop();
    await runtime.stopAttachedPiWork();
    expect(vi.mocked(f.native.abort).mock.calls).toEqual([[null], [null]]);
  });

  it("rejects an ancestor, loads a reported continuation, and ends the attachment on another branch", async () => {
    const f = nativeFixture({ leafId: "ancestor" });
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
    expect(await external.connect(slot)).toBe(false);
    f.setState({ leafId: "current" });
    expect(await external.connect(slot)).toBe(true);
    reconcile.mockClear();
    f.setState({ activity: "working", leafId: "continued" });
    expect(await external.connect(slot)).toBe(true);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    f.setState({ leafId: "sibling" });
    expect(await external.connect(slot)).toBe(false);
    expect(external.has(slot)).toBe(false);
  });

  it("keeps a cold addressed view read-only when an apparently idle Pi is already working", async () => {
    const f = nativeFixture();
    f.setState({ activity: "working", leafId: "u1" });
    const { createProcess } = workerFactory();
    const runtime = runtimeFor(await persistedRecord("a"), { createProcess })
      .setExternalSessionPresence(async () => ["u1"])
      .setExternalSessionConnector(async (_id, _file, _match, idleOnly) =>
        idleOnly ? f.native : null,
      );
    const release = runtime.retainSessionView("a");
    try {
      const { active } = await runtime.snapshot("a");
      expect(active?.readOnlyReason).toBe("external-active");
      expect(runtime.startupSessionHint).toBeNull();
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
    }
  });

  it("opens the current branch when the live Pi confirms it is still on an older node", async () => {
    const session = await persistedRecord("a");
    await appendFile(session.path, branchMessage("saved-current", "u1"));
    const { createProcess: create } = workerFactory();
    const runtime = runtimeFor(session, {
      createProcess: create,
    }).setExternalSessionPresence(async (_id, _file, _fresh, isAncestor) => {
      expect(isAncestor("u1")).toBe(true);
      return ["u1"];
    });
    const preview = await runtime.openSession("a");
    expect(preview.active?.effectiveLeafId).toBe("saved-current");
    expect(create).not.toHaveBeenCalled();
    await startWorker(runtime);
    expect(create).toHaveBeenCalledOnce();
    const snapshot = await runtime.snapshot("a");
    expect(snapshot.active?.readOnlyReason).toBeUndefined();
    expect(snapshot.active?.effectiveLeafId).toBe("saved-current");
  });

  it.each([null, undefined, "unavailable", "appeared"] as const)(
    "does not start a second writer when presence returns %s",
    async (presence) => {
      const ancestry = vi.fn(
        async (): Promise<(string | null | undefined)[]> => [presence],
      );
      if (presence === "unavailable")
        ancestry.mockRejectedValue(new Error("Cannot read registry"));
      if (presence === "appeared")
        ancestry
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValue(["not-yet-projected"]);
      const connect = vi.fn(async () => null);
      const { createProcess, workers } = workerFactory();
      const runtime = (
        await attachedRuntime(connect, {
          createProcess,
        })
      ).setExternalSessionPresence(ancestry);
      const release =
        presence === "unavailable" ? () => {} : runtime.retainSessionView("a");
      try {
        if (presence == null) {
          await expect(runtime.takeOverSession("a")).rejects.toMatchObject({
            code: "EXTERNAL_PI_WRITER_ACTIVE",
          });
          expect(connect).toHaveBeenCalledOnce();
          expect(ancestry).toHaveBeenCalledWith(
            "a",
            expect.any(String),
            true,
            expect.any(Function),
          );
          expect((await runtime.snapshot("a")).active?.readOnlyReason).toBe(
            "external-active",
          );
        } else {
          await runtime.snapshot("a");
          await expect(
            runtime.prompt({ sessionId: "a", message: "First input" }),
          ).rejects.toMatchObject({
            code:
              presence === "appeared"
                ? "EXTERNAL_PI_WRITER_ACTIVE"
                : "EXTERNAL_PI_PRESENCE_UNAVAILABLE",
          });
        }
        expect(workers.map(({ starts }) => starts)).toEqual(
          presence === "appeared" ? [0] : [],
        );
      } finally {
        release();
      }
    },
  );

  it("rechecks a merely viewed session on entry but keeps a worked-on session editable", async () => {
    let live: string[] = [];
    const { createProcess, workers } = workerFactory();
    const session = await persistedRecord("a");
    await persistedRecord("b");
    const runtime = runtimeFor(session, { createProcess })
      .setExternalSessionPresence(async () => live)
      .setExternalSessionConnector(async () => null);
    await runtime.openSession("a");
    await runtime.openSession("b");
    expect(workers).toHaveLength(0);
    await runtime.prompt({ sessionId: "b", message: "working here" });
    live = ["u1"];
    expect((await runtime.openSession("a")).active?.readOnlyReason).toBe(
      "external-active",
    );
    expect(
      (await runtime.openSession("b")).active?.readOnlyReason,
    ).toBeUndefined();
    expect(workers.map((worker) => [worker.sessionId, worker.stops])).toEqual([
      ["b", 0],
    ]);
  });

  it("observes short native run outcomes without replaying the initial report or claiming idle means success", async () => {
    const f = nativeFixture();
    const old = {
      id: "old",
      outcome: "completed" as const,
      settledAt: Date.now(),
    };
    const runs = { instanceId: "receiver", settled: [old] };
    f.setState({ activity: "idle", taskRuns: runs });
    const runtime = await attachedRuntime(async () => f.native);
    const outcomes = vi.fn();
    runtime.on("task_outcome", outcomes);
    await openAttached(runtime, "a");
    expect(outcomes).not.toHaveBeenCalled();
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
        expect(outcomes).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ id: "receiver:new", outcome: "failed" }),
        ),
      { timeout: 2_000 },
    );
    expect((await runtime.snapshot("a")).sessionStatuses.a?.runState).toBe(
      "failed",
    );
  });

  it("retries an unavailable takeover and keeps it through a later transient read failure", async () => {
    const f = nativeFixture();
    const runtime = await attachedRuntime(async () => f.native);
    const read = vi.mocked(f.native.read);
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
    const { createProcess, workers } = workerFactory();
    const session = await persistedRecord("a");
    await persistedRecord("b");
    const runtime = runtimeFor(session, { createProcess })
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
      await startWorker(runtime, "b");
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
      expect(runtime.startupSessionHint).toBe("b");
    } finally {
      deliver.resolve();
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
      const { createProcess: create } = workerFactory();
      const runtime = await attachedRuntime(connect, { createProcess: create });
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
    const { createProcess, workers } = workerFactory();
    const runtime = runtimeFor(session, { createProcess })
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
      const select = runtime.navigateBranch({
        sessionId: "a",
        targetId: "other-branch",
        revision: oldView.branchRevision!,
        mode: "watch",
      });
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
      expect(workers).toHaveLength(0);
    } finally {
      finish.resolve();
      release();
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
    const { createProcess, workers } = workerFactory((worker) => {
      worker.responseOverrides.set("prompt", () => {
        throw new Error("Pi did not attest the selected branch");
      });
    });
    const runtime = runtimeFor(session, { createProcess })
      .setExternalSessionPresence(async () => (live ? ["chosen"] : []))
      .setExternalSessionConnector(async (_id, _file, _match, idleOnly) =>
        idleOnly ? null : f.native,
      );
    await openAttached(runtime, "a");
    await expect(
      runtime.navigateBranch({
        sessionId: "a",
        targetId: "other",
        revision: (await runtime.snapshot("a")).active!.branchRevision!,
        mode: "watch",
      }),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(await runtime.snapshot("a")).toMatchObject({
      sessionStatuses: { a: { external: true, runState: "running" } },
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
    await expect(send()).rejects.toThrow(
      "Pi did not attest the selected branch",
    );
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

  it("ignores a retired receiver's late state and sends new input only after takeover", async () => {
    const first = nativeFixture();
    const replacement = nativeFixture();
    const entered = deferredSignal();
    const proceed = deferredSignal();
    let retired = false;
    let rediscovered = false;
    const { createProcess } = workerFactory();
    const connect = vi.fn(async () =>
      rediscovered ? replacement.native : retired ? null : first.native,
    );
    const runtime = (
      await attachedRuntime(connect, {
        createProcess,
      })
    ).setExternalSessionPresence(async () =>
      retired && !rediscovered ? [] : [null],
    );
    const events: string[] = [];
    runtime.on("event", ({ type }) => events.push(type));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const release = runtime.retainSessionView("a");
    try {
      await openAttached(runtime, "a");
      await runtime.prompt({ sessionId: "a", message: "Before exit" });
      events.length = 0;
      vi.mocked(first.native.read).mockImplementationOnce(async () => {
        entered.resolve();
        await proceed.promise;
        return nativeState({ activity: "working" });
      });
      const observing = vi.advanceTimersByTimeAsync(750);
      await entered.promise;
      retired = true;
      first.setState({ ended: "exited" });
      await expect(
        runtime.prompt({ sessionId: "a", message: "For retired Pi" }),
      ).rejects.toThrow(/connection has ended/);
      proceed.resolve();
      await observing;
      await vi.advanceTimersByTimeAsync(750);
      const snapshot = await runtime.snapshot("a");
      expect(snapshot.active?.readOnlyReason).toBeUndefined();
      expect(snapshot.sessionStatuses.a?.external).not.toBe(true);
      expect(snapshot.sessionStatuses.a?.runState ?? "idle").toBe("idle");
      expect(events).not.toContain("agent_start");

      rediscovered = true;
      await openAttached(runtime, "a");
      await runtime.prompt({ sessionId: "a", message: "Fresh" });
      expect(first.native.prompt).toHaveBeenCalledOnce();
      expect(replacement.native.prompt).toHaveBeenCalledExactlyOnceWith(
        "Fresh",
        undefined,
        expect.any(Function),
        undefined,
        null,
      );
      expect(connect).toHaveBeenCalledTimes(2);
      expect(createProcess).not.toHaveBeenCalled();
    } finally {
      release();
      proceed.resolve();
    }
  });

  it("follows a Pi that reports its new leaf after the append was already read", async () => {
    const session = await persistedRecord("a");
    const f = nativeFixture();
    f.setState({ activity: "working", leafId: "u1" });
    const runtime = runtimeFor(session)
      .setExternalSessionPresence(async () => ["u1"])
      .setExternalSessionConnector(async (_id, _file, _match, idleOnly) =>
        idleOnly ? null : f.native,
      );
    const events: Array<{ type: string; sessionId: string }> = [];
    runtime.on("event", (event) => events.push(event));
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
    const runtime = await attachedRuntime(async () => f.native, { store });
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
    const runtime = await attachedRuntime(async () => f.native);
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
      const runtime = runtimeFor(await persistedRecord("a"), {
        branchBridgeTimeoutMs: 15_000,
        deleteSessionRecord: remove,
      })
        .setExternalSessionPresence(async () => [null])
        .setExternalSessionConnector(async () => f.native);
      try {
        await openAttached(runtime, "a");
        const sending =
          operation === "prompt"
            ? runtime.prompt({ sessionId: "a", message: "Hold" })
            : runtime.abort("a");
        await entered.promise;
        expect(runtime.reserveMaintenanceRestart()).toMatchObject({
          kind: "busy",
        });
        runtime.setExternalSessionTerminator(terminated);
        await runtime.deleteSessions(
          { scope: "session", sessionId: "a" },
          { hiddenSessionIds: ["a"], hiddenProjectCwds: [] },
        );
        await sending;
        expect(terminated).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
      }
    },
  );

  it.each(["catalog", "poll", "reselect", "reaffirm"] as const)(
    "keeps selection authority during an older %s observation",
    async (source) => {
      vi.useFakeTimers();
      const { external, native, slot, state, selection } =
        await nativeModelFixture();
      const gate = deferredSignal();
      const selected = {
        model: { provider: "native", id: "selected" },
        thinkingLevel: "high" as const,
      };
      const models = [selection.model, selected.model];
      try {
        if (source === "reaffirm") {
          for (const setter of [
            () => external.setModel(slot, "native", "current"),
            () => external.setThinkingLevel(slot, "low"),
          ]) {
            const late = Promise.withResolvers<
              typeof selected & { models: typeof models }
            >();
            vi.mocked(native.models).mockReturnValueOnce(late.promise);
            const reading = external.models(slot);
            await setter();
            late.resolve({ ...selected, models });
            expect(await reading).toEqual({ ...selection, models });
          }
          expect(external.modelSelection(slot)).toEqual(selection);
          return;
        }
        vi.mocked(native.setModel).mockResolvedValue({
          ...selected,
          thinkingLevel: "low",
        });
        vi.mocked(native.setThinkingLevel).mockResolvedValue(selected);
        let reading: Promise<unknown> | undefined;
        if (source === "catalog") {
          vi.mocked(native.models).mockImplementationOnce(async () => {
            await gate.promise;
            return { ...selection, models };
          });
          reading = external.models(slot);
        } else {
          vi.mocked(native.read).mockImplementationOnce(async () => {
            await gate.promise;
            return { ...state, activity: "working" };
          });
          if (source === "reselect") reading = external.connect(slot);
          else await vi.advanceTimersByTimeAsync(10);
          expect(native.read).toHaveBeenCalledTimes(2);
        }
        await external.setModel(slot, "native", "selected");
        await external.setThinkingLevel(slot, "high");
        gate.resolve();
        const response = await reading;
        await vi.advanceTimersByTimeAsync(0);
        expect(external.modelSelection(slot)).toEqual(selected);
        if (source === "catalog") {
          expect(response).toEqual({ ...selected, models });
          expect(slot.availableModels).toEqual(models);
        } else {
          expect(slot.runState).toBe("running");
          await vi.advanceTimersByTimeAsync(10);
          expect(external.modelSelection(slot)).toEqual(selection);
        }
      } finally {
        gate.resolve();
      }
    },
  );

  it.each(["native reload", "new connection"] as const)(
    "ignores catalog and setter replies from before %s",
    async (change) => {
      vi.useFakeTimers();
      const f = await nativeModelFixture();
      const gate = deferredSignal();
      const successor = {
        model: { provider: "native", id: "successor" },
        thinkingLevel: "high" as const,
      };
      const models = [{ provider: "fresh", id: "available" }];
      const late = async () => {
        await gate.promise;
        return f.selection;
      };
      vi.mocked(f.native.models).mockImplementationOnce(async () => ({
        ...(await late()),
        models: [{ provider: "old", id: "retired" }],
      }));
      vi.mocked(f.native.setModel).mockImplementationOnce(late);
      vi.mocked(f.native.setThinkingLevel).mockImplementationOnce(late);
      try {
        const { external, slot, native, replacement } = f;
        const outcomes = Promise.allSettled([
          external.models(slot),
          external.setModel(slot, "native", "current"),
          external.setThinkingLevel(slot, "low"),
        ]);
        if (change === "native reload") {
          vi.mocked(native.models).mockResolvedValue({ ...successor, models });
          f.setState({
            ...f.state,
            modelSelection: successor,
            taskRuns: { ...f.state.taskRuns, instanceId: "receiver-two" },
          });
          f.emit.mockClear();
          await vi.advanceTimersByTimeAsync(10);
          expect(f.emit).toHaveBeenCalledWith(slot, {
            type: "model_metadata_changed",
          });
        } else {
          vi.mocked(replacement.native.models).mockResolvedValue({
            ...successor,
            models,
          });
          await f.replace();
        }
        expect(slot.availableModels).toBeNull();
        await expect(external.models(slot)).resolves.toEqual({
          ...successor,
          models,
        });
        const events = f.emit.mock.calls.length;
        gate.resolve();
        for (const result of await outcomes)
          expect(result).toMatchObject({
            status: "rejected",
            reason: { status: 409 },
          });
        expect(slot.availableModels).toEqual(models);
        expect(external.modelSelection(slot)).toEqual(successor);
        expect(f.emit).toHaveBeenCalledTimes(events);
      } finally {
        gate.resolve();
      }
    },
  );

  it("coalesces failed native polls until one complete observation succeeds", async () => {
    vi.useFakeTimers();
    const f = nativeFixture();
    const reconcile = vi.fn(async (): Promise<unknown> => {
      throw new Error("Projection read failed");
    });
    const { slot, external, log } = await directAttachment(
      async () => f.native,
      { reconcile },
    );
    await external.connect(slot);
    await vi.advanceTimersByTimeAsync(20);
    expect(log).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(slot, false);
    reconcile.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(20);
    expect(log).toHaveBeenCalledTimes(2);
    slot.projection = null;
    const reconciliations = reconcile.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20);
    expect(reconcile).toHaveBeenCalledTimes(reconciliations);
  });

  it.each([
    ["exited", { ended: "exited" }],
    ["unreachable", { ended: "unreachable" }],
    ["left-branch", { activity: "working", leafId: "elsewhere" }],
  ] as const)(
    "retire a busy attachment on %s without reporting failure",
    async (reason, state) => {
      vi.useFakeTimers();
      const f = nativeFixture({ activity: "working" });
      const { slot, external, emit, taskOutcome, released } =
        await directAttachment(async () => f.native, {
          corresponds: (_slot, leaf) => leaf !== "elsewhere",
        });
      await external.connect(slot);
      expect(slot.runState).toBe("running");
      f.setState(state);
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
      expect(taskOutcome.mock.calls).toEqual(
        reason === "exited" ? [[slot, "ended"]] : [],
      );
    },
  );

  it("discards a takeover that resolves after Host shutdown", async () => {
    const f = nativeFixture();
    const gate = deferredSignal();
    const connect = vi.fn(async () => {
      await gate.promise;
      return f.native;
    });
    const runtime = await attachedRuntime(connect);
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
