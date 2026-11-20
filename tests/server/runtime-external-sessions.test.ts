import { appendFile, rename } from "node:fs/promises";
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
import { createRuntimeSlot } from "../../server/runtime-slot.js";
import {
  SessionCatalog,
  type SessionRecord,
} from "../../server/session-catalog.js";
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
} from "./fixtures/runtime.js";
import { jsonl, messageEntry } from "./fixtures/session-jsonl.js";

const directlyAttached: Array<{
  external: RuntimeExternalSessions;
  projection: Awaited<ReturnType<typeof preview>>;
}> = [];

beforeEach(async () => {
  await initializeRuntimeFixture();
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", fixtureWorkspace);
});
afterEach(async () => {
  try {
    for (const { external, projection } of directlyAttached.splice(0)) {
      external.close();
      await projection.close();
    }
  } finally {
    vi.useRealTimers();
    await disposeRuntimeFixture();
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
) {
  const runtime = new RuntimeController(
    new SessionCatalog(session.cwd),
    trackedAttachmentStore(),
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
async function attachedRuntime(connect: ConnectExternalSession) {
  const session = record("a", fixtureWorkspace);
  await (await preview(session, [])).close();
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(fixtureWorkspace, "previews"));
  return runtimeFor(session, {
    externalLeaves: async () => [null],
    connectExternalSession: async (id, file, match, idleOnly) =>
      idleOnly ? null : connect(id, file, match, idleOnly),
  });
}

/** Opening shows the live Pi read-only; Take over attaches to it. */
async function openAttached(runtime: RuntimeController, id: string) {
  await runtime.openSession(id);
  return runtime.takeOverSession(id);
}

describe("continue an externally owned Pi", () => {
  it("detects live attached work before the next poll and requires a confirmed Stop for restart", async () => {
    const f = nativeFixture();
    const runtime = await attachedRuntime(async () => f.native);
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
          f.setState({ activity: "working" });
        }
        if (await commit()) {
          dispatch();
          return { kind: "issued" };
        }
        expect(f.native.read).toHaveBeenCalledTimes(before + 1);
        expect(events).not.toContain("agent_start");
        return { kind: "not-issued", reason: "commit-not-authorized" };
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

      const unconfirmed = () =>
        expect(runtime.stopAttachedPiWork()).rejects.toThrow(
          "Could not confirm Stop for a. Work may still be running.",
        );
      vi.mocked(f.native.read).mockRejectedValueOnce(new Error("Unavailable"));
      await unconfirmed();
      expect(f.native.abort).not.toHaveBeenCalled();
      vi.mocked(f.native.abort).mockRejectedValueOnce(
        new Error("No Stop receipt"),
      );
      await unconfirmed();

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
      expect(vi.mocked(f.native.abort).mock.calls).toEqual([[null], [null]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks cold writer admission for busy, unreachable or unknown native ownership", async () => {
    const empty = record("empty", fixtureWorkspace);
    await (await preview(empty, [])).close();
    await rename(empty.path, join(fixtureWorkspace, "empty.jsonl"));
    const session = await persistedRecord("a");
    const native = nativeFixture({ activity: "working", leafId: "u1" }).native;
    const { createProcess, workers } = workerFactory();
    const presence = vi.fn(
      async (
        ..._args: Parameters<
          NonNullable<RuntimeControllerOptions["externalLeaves"]>
        >
      ): Promise<(string | null | undefined)[]> => ["u1"],
    );
    const runtime = runtimeFor(session, {
      createProcess,
      externalLeaves: presence,
      connectExternalSession: async (_id, _file, _match, idleOnly) =>
        idleOnly ? native : null,
    });
    const snapshot = () => runtime.snapshot("a");
    const send = () =>
      runtime.prompt({ sessionId: "a", message: "First input" });
    const active = { code: "EXTERNAL_PI_WRITER_ACTIVE" };
    const release = runtime.retainSessionView("a");
    try {
      expect((await snapshot()).active?.readOnlyReason).toBe("external-active");
      expect(runtime.startupSessionHint).toBeNull();
      await expect(send()).rejects.toMatchObject(active);
      await expect(
        runtime.setModel("a", "test", "model"),
      ).rejects.toMatchObject(active);
      expect(native.prompt).not.toHaveBeenCalled();
      expect(native.setModel).not.toHaveBeenCalled();

      // A null report belongs to the selected branch when the durable file is still empty.
      for (const [id, leaf] of [
        [empty.id, null],
        ["a", undefined],
      ] as const) {
        presence.mockResolvedValue([leaf]);
        await expect(runtime.takeOverSession(id)).rejects.toMatchObject(active);
        expect(presence).toHaveBeenCalledWith(
          id,
          expect.any(String),
          true,
          expect.any(Function),
        );
      }
      presence.mockResolvedValue([]);
      expect((await snapshot()).active?.readOnlyReason).toBeUndefined();
      presence.mockRejectedValue(new Error("Cannot read registry"));
      await expect(send()).rejects.toMatchObject({
        code: "EXTERNAL_PI_PRESENCE_UNAVAILABLE",
      });
      expect(createProcess).not.toHaveBeenCalled();

      presence.mockResolvedValue([]);
      await snapshot();
      presence
        .mockResolvedValueOnce([])
        .mockResolvedValue(["not-yet-projected"]);
      await expect(send()).rejects.toMatchObject(active);
      expect(workers.map(({ starts }) => starts)).toEqual([0]);
      await appendFile(session.path, branchMessage("saved-current", "u1"));
      presence.mockResolvedValue(["u1"]);
      await runtime.navigateBranch({
        sessionId: "a",
        targetId: "saved-current",
        revision: (await snapshot()).active!.branchRevision!,
        mode: "watch",
      });
      expect((await snapshot()).active?.readOnlyReason).toBeUndefined();
      await startWorker(runtime);
      expect(workers.map(({ starts }) => starts)).toEqual([0, 1]);
      expect((await snapshot()).active).toMatchObject({
        effectiveLeafId: "saved-current",
        readOnlyReason: undefined,
      });
    } finally {
      release();
    }
  });

  it("rechecks cold ownership and sends input and Stop to the attached Pi after switching sessions", async () => {
    const f = nativeFixture({ leafId: "u1" });
    const entered = deferredSignal();
    const deliver = deferredSignal();
    const prepared = deferredSignal();
    const stopped = deferredSignal();
    const delivered: string[] = [];
    vi.mocked(f.native.prompt).mockImplementation(
      async (message, _behavior, beforeSend) => {
        if (message === "For A only") {
          entered.resolve();
          await deliver.promise;
        } else if (message === "Stopped before delivery") {
          prepared.resolve();
          await stopped.promise;
        }
        beforeSend?.();
        delivered.push(message);
        f.setState({ activity: "working", leafId: "u1" });
      },
    );
    const { createProcess, workers } = workerFactory();
    const session = await persistedRecord("a");
    await persistedRecord("b");
    let live = false;
    const runtime = runtimeFor(session, {
      createProcess,
      externalLeaves: async (id) => (live && id === "a" ? ["u1"] : []),
      connectExternalSession: async (id, _file, _match, idleOnly) =>
        live && id === "a" && !idleOnly ? f.native : null,
    });
    const settled = vi.fn();
    runtime.on("event", (event) => {
      if (event.type === "agent_settled") settled(event);
    });
    try {
      await runtime.openSession("a");
      await runtime.openSession("b");
      expect(createProcess).not.toHaveBeenCalled();
      await runtime.prompt({ sessionId: "b", message: "Working here" });
      live = true;
      expect((await runtime.openSession("a")).active?.readOnlyReason).toBe(
        "external-active",
      );
      await runtime.takeOverSession("a");
      const send = (message: string) =>
        runtime.prompt({ sessionId: "a", message });
      const sending = send("For A only");
      await entered.promise;
      expect(
        (await runtime.openSession("b")).active?.readOnlyReason,
      ).toBeUndefined();
      deliver.resolve();
      await sending;
      expect(delivered).toEqual(["For A only"]);

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
      const canceled = expect(
        send("Stopped before delivery"),
      ).rejects.toMatchObject({ status: 409 });
      await prepared.promise;
      await runtime.abort("a");
      stopped.resolve();
      await canceled;
      await send("Fresh");
      expect(delivered).toEqual(["For A only", "Fresh"]);
      expect(vi.mocked(f.native.abort).mock.calls).toEqual([["u1"], ["u1"]]);
      expect(workers.map(({ sessionId, stops }) => [sessionId, stops])).toEqual(
        [["b", 0]],
      );
      expect(runtime.startupSessionHint).toBe("b");
    } finally {
      deliver.resolve();
      stopped.resolve();
    }
  });

  it("fences sends across Watch, recalled input, and a failed return to Inspire", async () => {
    const session = await persistedRecord("a");
    await appendFile(session.path, branchMessage("chosen", "u1"));
    const f = nativeFixture({ activity: "working", leafId: "chosen" });
    const scanning = deferredSignal();
    const finish = deferredSignal();
    let live = true;
    const presence = vi.fn(async () => (live ? ["chosen"] : []));
    const { createProcess, workers } = workerFactory((worker) => {
      worker.responseOverrides.set("prompt", () => {
        throw new Error("Pi did not attest the selected branch");
      });
    });
    const runtime = runtimeFor(session, {
      createProcess,
      externalLeaves: presence,
      connectExternalSession: async (_id, _file, _match, idleOnly) =>
        idleOnly ? null : f.native,
    });
    const send = (message: string, expectedViewId?: string) =>
      runtime.prompt({ sessionId: "a", message, expectedViewId });
    const active = async () => (await runtime.snapshot("a")).active!;
    const watch = async (targetId: string) =>
      runtime.navigateBranch({
        sessionId: "a",
        targetId,
        revision: (await active()).branchRevision!,
        mode: "watch",
      });
    const release = runtime.retainSessionView("a");
    try {
      await runtime.openSession("a");
      expect((await active()).readOnlyReason).toBe("external-active");
      await appendFile(session.path, branchMessage("other", "u1"));
      const original = await active();
      expect(original.effectiveLeafId).toBe("chosen");
      presence.mockImplementationOnce(async () => {
        scanning.resolve();
        await finish.promise;
        return ["chosen"];
      });
      const changing = runtime.navigateBranch({
        sessionId: "a",
        targetId: "other",
        revision: original.branchRevision!,
        mode: "watch",
      });
      await scanning.promise;
      const fenced = { code: "PROMPT_VIEW_CHANGED" };
      const sending = expect(send("For chosen branch")).rejects.toMatchObject(
        fenced,
      );
      finish.resolve();
      await Promise.all([changing, sending]);
      await expect(
        send("For chosen branch", original.transcriptPage.viewId),
      ).rejects.toMatchObject(fenced);
      expect((await active()).effectiveLeafId).toBe("other");

      await watch("chosen");
      await runtime.takeOverSession("a");
      await expect(watch("other")).rejects.toMatchObject({ status: 409 });
      expect((await runtime.snapshot("a")).sessionStatuses.a).toMatchObject({
        external: true,
        runState: "running",
      });
      f.setState({ leafId: "chosen" });
      await appendFile(session.path, branchMessage("other-tip", "other"));
      const chosen = await active();
      expect(chosen).toMatchObject({
        effectiveLeafId: "chosen",
        durableLeafId: "other-tip",
      });
      const { viewId, incarnation } = chosen.transcriptPage;
      await runtime.prompt({
        sessionId: "a",
        message: "Recall from attached view",
        historyArtifacts: {
          viewId,
          incarnation: incarnation ?? null,
          effectiveLeafId: "chosen",
          imageReferences: [],
          fileReferences: [],
        },
      });
      expect(f.native.prompt).toHaveBeenCalledExactlyOnceWith(
        "Recall from attached view",
        undefined,
        expect.any(Function),
        undefined,
        "chosen",
      );

      f.setState({ ended: "exited" });
      live = false;
      await expect(send("For chosen branch")).rejects.toThrow(
        /connection has ended/,
      );
      expect(createProcess).not.toHaveBeenCalled();
      await expect(send("For chosen branch")).rejects.toThrow(
        "Pi did not attest the selected branch",
      );
      expect(workers).toHaveLength(1);
      expect(workers[0]!.stops).toBeGreaterThan(0);
      expect(workers[0]!.commands).not.toContainEqual({
        type: "prompt",
        message: "For chosen branch",
      });
    } finally {
      finish.resolve();
      release();
    }
  });

  it("observes one attached branch through native appends and receiver replacement", async () => {
    const session = await persistedRecord("a");
    await appendFile(session.path, branchMessage("native-current", "u1"));
    const current = nativeFixture({ leafId: "u1" });
    const replacement = nativeFixture({ leafId: "native-reply" });
    const read = vi.mocked(current.native.read);
    const { createProcess } = workerFactory();
    let receiver: ExternalSessionConnection | null = current.native;
    const connect = vi.fn(async () => receiver);
    const runtime = runtimeFor(session, {
      createProcess,
      externalLeaves: async () =>
        receiver === current.native
          ? ["native-current"]
          : receiver
            ? ["native-reply"]
            : [],
      connectExternalSession: async (_id, _file, _match, idleOnly) =>
        idleOnly ? null : connect(),
    });
    const outcomes = vi.fn();
    const events: string[] = [];
    runtime.on("task_outcome", outcomes);
    runtime.on("event", ({ type }) => events.push(type));
    const entered = deferredSignal();
    const late = deferredSignal();
    const release = runtime.retainSessionView("a");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const snapshot = () => runtime.snapshot("a");
      const old = {
        id: "old",
        outcome: "completed",
        settledAt: Date.now(),
      } as const;
      const runs = { instanceId: "receiver", settled: [old] };
      current.setState({ leafId: "native-current", taskRuns: runs });
      await openAttached(runtime, "a");
      expect(outcomes).not.toHaveBeenCalled();
      await appendFile(
        session.path,
        branchMessage("native-reply", "native-current"),
      );
      const saved = (await snapshot()).active!;
      expect(saved).toMatchObject({
        durableLeafId: "native-reply",
        effectiveLeafId: "native-current",
        projectionConflict: null,
      });
      events.length = 0;
      const failed = {
        id: "new",
        outcome: "failed",
        settledAt: Date.now(),
      } as const;
      const taskRuns = { ...runs, settled: [old, failed] };
      current.setState({ leafId: "native-reply", taskRuns });
      await vi.waitFor(() =>
        expect(outcomes).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ id: "receiver:new", outcome: "failed" }),
        ),
      );
      expect(events).toContain("session_projection_changed");
      expect(await snapshot()).toMatchObject({
        sessionStatuses: { a: { runState: "failed" } },
        active: {
          effectiveLeafId: "native-reply",
          transcriptPage: {
            viewId: saved.transcriptPage.viewId,
            messages: expect.arrayContaining([
              expect.objectContaining({ __inspireEntryId: "native-reply" }),
            ]),
          },
        },
      });

      const send = (message: string) =>
        runtime.prompt({ sessionId: "a", message });
      current.setState({ leafId: "native-reply" });
      await send("Before exit");
      current.setState({ activity: "working", leafId: "native-reply" });
      await vi.waitFor(async () =>
        expect((await snapshot()).sessionStatuses.a?.runState).toBe("running"),
      );
      events.length = 0;
      read.mockImplementationOnce(async () => {
        entered.resolve();
        await late.promise;
        return nativeState({ activity: "working", leafId: "native-reply" });
      });
      const reads = read.mock.calls.length;
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(reads + 1));
      await entered.promise;
      receiver = null;
      current.setState({ ended: "exited" });
      await Promise.all([
        expect(send("For retired Pi")).rejects.toThrow(/connection has ended/),
        ...[
          runtime.rename("a", "For retired Pi"),
          runtime.setModel("a", "native", "model"),
          runtime.setThinkingLevel("a", "high"),
        ].map((mutation) =>
          expect(mutation).rejects.toMatchObject({ status: 409 }),
        ),
      ]);
      for (const action of [
        "rename",
        "setModel",
        "setThinkingLevel",
      ] as const) {
        expect(current.native[action]).not.toHaveBeenCalled();
        expect(replacement.native[action]).not.toHaveBeenCalled();
      }
      late.resolve();
      await vi.advanceTimersByTimeAsync(750);
      const retired = await snapshot();
      expect(retired.active?.readOnlyReason).toBeUndefined();
      expect(retired.sessionStatuses.a?.external).not.toBe(true);
      expect(retired.sessionStatuses.a?.runState ?? "idle").toBe("idle");
      expect(events).toContain("external_attachment_ended");
      expect(events).not.toContain("agent_start");
      expect(events).not.toContain("runtime_error");
      expect(outcomes.mock.calls.map(([item]) => item.outcome)).toEqual([
        "failed",
        "ended",
      ]);

      receiver = replacement.native;
      await openAttached(runtime, "a");
      await send("Fresh");
      expect(current.native.prompt).toHaveBeenCalledOnce();
      expect(replacement.native.prompt).toHaveBeenCalledExactlyOnceWith(
        "Fresh",
        undefined,
        expect.any(Function),
        undefined,
        "native-reply",
      );
      expect(createProcess).not.toHaveBeenCalled();
    } finally {
      release();
      late.resolve();
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
        stopExternalSession: terminated,
        externalLeaves: async () => [null],
        connectExternalSession: async () => f.native,
      });
      try {
        await openAttached(runtime, "a");
        const sending =
          operation === "prompt"
            ? runtime.prompt({ sessionId: "a", message: "Hold" })
            : runtime.abort("a");
        await entered.promise;
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

  it("keeps native selection authority across older catalog and poll replies", async () => {
    vi.useFakeTimers();
    const { external, native, slot, state, selection } =
      await nativeModelFixture();
    const previous = { ...selection, models: [selection.model] };
    const selected = {
      model: { provider: "native", id: "selected" },
      thinkingLevel: "high" as const,
    };
    const confirmed = { ...selected, models: previous.models };
    const select = async () => {
      await external.setModel(slot, "native", "selected");
      await external.setThinkingLevel(slot, "high");
    };
    vi.mocked(native.setModel).mockResolvedValue({
      ...selected,
      thinkingLevel: "low",
    });
    vi.mocked(native.setThinkingLevel).mockResolvedValue(selected);
    const catalog = Promise.withResolvers<typeof previous>();
    vi.mocked(native.models).mockReturnValueOnce(catalog.promise);
    const reading = external.models(slot);
    try {
      await select();
    } finally {
      catalog.resolve(previous);
    }
    await expect(reading).resolves.toEqual(confirmed);
    expect(slot.availableModels).toEqual(previous.models);

    const delayed = Promise.withResolvers<ExternalSessionRead>();
    vi.mocked(native.read).mockReturnValueOnce(delayed.promise);
    await vi.advanceTimersByTimeAsync(10);
    try {
      await select();
    } finally {
      delayed.resolve({ ...state, activity: "working" });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(slot.runState).toBe("running");
    expect(external.modelSelection(slot)).toEqual(selected);
    await vi.advanceTimersByTimeAsync(10);
    expect(external.modelSelection(slot)).toEqual(selection);
  });

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
      expect(taskOutcome).not.toHaveBeenCalled();
    },
  );

  it("refuses a takeover completing after shutdown", async () => {
    const f = nativeFixture();
    const gate = deferredSignal();
    const connect = vi.fn(async () => {
      await gate.promise;
      return f.native;
    });
    const runtime = await attachedRuntime(connect);
    const taking = openAttached(runtime, "a").catch(() => undefined);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const closing = runtime.close();
    gate.resolve();
    await closing;
    await taking;
    expect(f.native.read).not.toHaveBeenCalled();
    expect(f.native.prompt).not.toHaveBeenCalled();
  });
});
