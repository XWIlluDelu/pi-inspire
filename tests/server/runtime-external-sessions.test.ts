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
import { createRuntimeSlot } from "../../server/runtime-slot.js";
import {
  SessionCatalog,
  type SessionRecord,
} from "../../server/session-catalog.js";
import { parseAttachmentContext } from "../../shared/attachment-context.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";
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
    const runtime = runtimeFor(session, { createProcess })
      .setExternalSessionPresence(async (id) =>
        live && id === "a" ? ["u1"] : [],
      )
      .setExternalSessionConnector(async (id, _file, _match, idleOnly) =>
        live && id === "a" && !idleOnly ? f.native : null,
      );
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

  it.each(["rename", "setModel", "setThinkingLevel"] as const)(
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
    const runtime = runtimeFor(session, { createProcess })
      .setExternalSessionPresence(presence)
      .setExternalSessionConnector(async (_id, _file, _match, idleOnly) =>
        idleOnly ? null : f.native,
      );
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

  it("observes one attached branch through takeover retry, native appends, and receiver replacement", async () => {
    const session = await persistedRecord("a");
    await appendFile(session.path, branchMessage("native-current", "u1"));
    const current = nativeFixture({ leafId: "u1" });
    const replacement = nativeFixture({ leafId: "native-reply" });
    const read = vi.mocked(current.native.read);
    const { createProcess } = workerFactory();
    let receiver: ExternalSessionConnection | null = current.native;
    const connect = vi.fn(async () => receiver);
    const runtime = runtimeFor(session, { createProcess })
      .setExternalSessionPresence(async () =>
        receiver === current.native
          ? ["native-current"]
          : receiver
            ? ["native-reply"]
            : [],
      )
      .setExternalSessionConnector(async (_id, _file, _match, idleOnly) =>
        idleOnly ? null : connect(),
      );
    const outcomes = vi.fn();
    const events: string[] = [];
    runtime.on("task_outcome", outcomes);
    runtime.on("event", ({ type }) => events.push(type));
    const entered = deferredSignal();
    const late = deferredSignal();
    const release = runtime.retainSessionView("a");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      read.mockRejectedValueOnce(new Error("Control endpoint unavailable"));
      await expect(openAttached(runtime, "a")).rejects.toThrow(
        "Control endpoint unavailable",
      );
      const snapshot = () => runtime.snapshot("a");
      expect((await snapshot()).active?.readOnlyReason).toBe("external-active");

      await expect(runtime.takeOverSession("a")).rejects.toMatchObject({
        code: "EXTERNAL_PI_WRITER_ACTIVE",
      });
      const old = {
        id: "old",
        outcome: "completed",
        settledAt: Date.now(),
      } as const;
      const runs = { instanceId: "receiver", settled: [old] };
      current.setState({ leafId: "native-current", taskRuns: runs });
      const attached = await runtime.takeOverSession("a");
      expect(attached.sessionStatuses.a?.external).toBe(true);
      expect(outcomes).not.toHaveBeenCalled();
      const priorReads = read.mock.calls.length;
      read.mockRejectedValueOnce(new Error("reloading"));
      await vi.advanceTimersByTimeAsync(750);
      expect(read).toHaveBeenCalledTimes(priorReads + 1);
      expect((await snapshot()).active?.readOnlyReason).toBeUndefined();

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

      current.setState({
        activity: "working",
        leafId: "native-reply",
        taskRuns,
      });
      const send = (message: string, behavior?: "steer" | "followUp") =>
        runtime.prompt({ sessionId: "a", message, behavior });
      for (const behavior of ["steer", "followUp"] as const) {
        await expect(send(behavior, behavior)).rejects.toMatchObject({
          code: "ATTACH_CONTROL_QUEUE_ACK_UNAVAILABLE",
        });
      }
      expect(current.native.prompt).not.toHaveBeenCalled();
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
      await expect(send("For retired Pi")).rejects.toThrow(
        /connection has ended/,
      );
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
      expect(connect).toHaveBeenCalledTimes(4);
      expect(createProcess).not.toHaveBeenCalled();
    } finally {
      release();
      late.resolve();
    }
  });

  it("keeps attached-prompt bytes through refusal and a lost receipt, then retires only transport copies", async () => {
    const f = nativeFixture();
    const store = trackedAttachmentStore();
    const prompt = vi.mocked(f.native.prompt);
    const runtime = await attachedRuntime(async () => f.native, { store });
    await openAttached(runtime, "a");

    const imageUpload = upload("image.png", "image/png");
    const fileUpload = upload("notes.txt", "text/plain");
    const payload = imageUpload.buffer;
    const image = await store.add(imageUpload);
    const file = await store.add(fileUpload);
    const send = (message: string, attachmentIds: string[]) =>
      runtime.prompt({ sessionId: "a", message, attachmentIds });
    prompt.mockImplementationOnce(async (text, _behavior, _before, images) => {
      expect(text).toBe("");
      expect(images).toHaveLength(1);
      expect(await readFile(images![0]!.path)).toEqual(payload);
      throw new Error("Native question is waiting");
    });
    await expect(send("", [image.id])).rejects.toThrow("Native question");
    expect((await store.imagePreview(image.id)).bytes).toEqual(payload);

    const attachments = [image.id, file.id];
    prompt.mockRejectedValueOnce(
      Object.assign(new Error("Receipt lost"), { outcomeUnknown: true }),
    );
    await expect(send("Read this", attachments)).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    expect(prompt).toHaveBeenCalledTimes(2);
    const [message, , , images] = prompt.mock.lastCall!;
    const imagePath = images![0]!.path;
    const filePath = parseAttachmentContext(message, 1).references[0]!;
    expect((await store.imagePreview(image.id)).bytes).toEqual(payload);

    await send("Read this", attachments);
    expect(prompt.mock.lastCall?.[3]).toEqual([
      expect.objectContaining({ mimeType: "image/png" }),
    ]);
    await expect(store.imagePreview(image.id)).rejects.toMatchObject({
      status: 404,
    });
    await store.remove(file.id);
    expect(store.ownsPromptFile(filePath)).toBe(true);
    expect(await readFile(imagePath)).toEqual(payload);
    expect((await store.collectStaged()).reclaimed).not.toContain(imagePath);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.advanceTimersByTime(6 * 60_000);
    await expect(store.collectStaged()).resolves.toMatchObject({
      reclaimed: [imagePath],
    });
    await expect(readFile(imagePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(filePath)).toEqual(fileUpload.buffer);
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

  it("keeps native selection authority across older catalog, poll, and reselect replies", async () => {
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

    for (const source of ["poll", "reselect"] as const) {
      const delayed = Promise.withResolvers<ExternalSessionRead>();
      vi.mocked(native.read).mockReturnValueOnce(delayed.promise);
      const observation =
        source === "reselect" ? external.connect(slot) : undefined;
      if (!observation) await vi.advanceTimersByTimeAsync(10);
      try {
        await select();
      } finally {
        delayed.resolve({ ...state, activity: "working" });
      }
      await observation;
      await vi.advanceTimersByTimeAsync(0);
      expect(slot.runState).toBe("running");
      expect(external.modelSelection(slot)).toEqual(selected);
      await vi.advanceTimersByTimeAsync(10);
      expect(external.modelSelection(slot)).toEqual(selection);
    }

    vi.mocked(native.setModel).mockResolvedValue(selection);
    vi.mocked(native.setThinkingLevel).mockResolvedValue(selection);
    for (const reaffirm of [
      () => external.setModel(slot, "native", "current"),
      () => external.setThinkingLevel(slot, "low"),
    ]) {
      const late = Promise.withResolvers<typeof confirmed>();
      vi.mocked(native.models).mockReturnValueOnce(late.promise);
      const result = external.models(slot);
      try {
        await reaffirm();
      } finally {
        late.resolve(confirmed);
      }
      await expect(result).resolves.toEqual(previous);
    }
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
