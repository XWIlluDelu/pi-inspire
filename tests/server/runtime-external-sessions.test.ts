import { appendFile, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullDiagnosticLogger } from "../../server/diagnostics.js";
import type {
  ConnectExternalSession,
  ExternalSessionConnection,
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

type NativeRead = Awaited<ReturnType<ExternalSessionConnection["read"]>>;

function nativeFixture() {
  let state: NativeRead = { status: "idle" };
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
    close: vi.fn(),
  };
  return {
    native,
    setState: (next: NativeRead) => {
      state = next;
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
  const state: ExternalSessionState = {
    status: "idle",
    modelSelection: selection,
    taskRuns: { instanceId: "receiver-one", activeRunId: null, settled: [] },
  };
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

/** A runtime over session "a" where a live Pi continues the branch. Owned
 * workers are refused unless a test supplies a factory. */
function attachedRuntime(
  connect: ConnectExternalSession,
  spawn: RuntimeControllerOptions["createProcess"] = () => {
    throw new Error("must not launch Pi");
  },
) {
  return new RuntimeController(
    catalog([record("a", "/tmp")]),
    trackedAttachmentStore(),
    { createProcess: spawn, openSessionProjection: preview },
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
    f.setState({ status: "idle", leafId: "u1" });
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        createProcess: () => {
          throw new Error("must not launch Pi");
        },
      },
    )
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
          f.setState({ status: "working", leafId: "u1" });
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

  it("blocks a restart when an attached Pi becomes busy after reservation", async () => {
    const session = await persistedRecord("a");
    const f = nativeFixture();
    f.setState({ status: "idle", leafId: "u1" });
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        createProcess: () => {
          throw new Error("must not launch Pi");
        },
      },
    )
      .setExternalSessionPresence(async () => ["u1"])
      .setExternalSessionConnector(async () => f.native);
    const events: string[] = [];
    runtime.on("event", (event) => events.push(event.type));
    try {
      await openAttached(runtime, "a");
      const lease = runtime.reserveMaintenanceRestart(false, true);
      if (lease.kind !== "ready") throw new Error("Expected an idle lease");
      f.setState({ status: "working", leafId: "u1" });
      await vi.waitFor(() => expect(events).toContain("agent_start"), {
        timeout: 2000,
      });
      expect(runtime.commitMaintenanceRestart(lease.leaseId)).toEqual({
        kind: "skipped",
        reason: "active-work",
      });
      expect(runtime.releaseMaintenanceRestart(lease.leaseId).kind).toBe(
        "released",
      );
      await runtime.stopAttachedPiWork();
      expect(f.native.abort).toHaveBeenCalledExactlyOnceWith("u1");
    } finally {
      await runtime.close();
    }
  });

  it("requires a verified leaf for restart interruption and accepts an empty branch", async () => {
    const f = nativeFixture();
    f.setState({ status: "working" });
    const { slot, external } = await directAttachment(async () => f.native);
    try {
      expect(await external.connect(slot)).toBe(true);
      await expect(external.abort(slot, true)).rejects.toThrow(
        "verify the branch",
      );
      expect(f.native.abort).not.toHaveBeenCalled();
      f.setState({ status: "working", leafId: null });
      await external.abort(slot, true);
      expect(f.native.abort).toHaveBeenCalledExactlyOnceWith(null);
    } finally {
      external.close();
    }
  });

  it("retains an idle takeover through ordinary navigation and worker-cache reclamation", async () => {
    const f = nativeFixture();
    const spawn = vi.fn(() => {
      throw new Error("must keep the attached Pi");
    });
    const connector = vi.fn(async () => f.native);
    const runtime = attachedRuntime(connector, spawn);
    try {
      await openAttached(runtime, "a");
      await runtime.deselectSession();
      await (
        runtime as unknown as { workerPool: { settled(): Promise<void> } }
      ).workerPool.settled();
      expect(f.native.close).not.toHaveBeenCalled();
      await runtime.openSession("a");
      await runtime.prompt({ sessionId: "a", message: "continue here" });
      expect(connector).toHaveBeenCalledOnce();
      expect(f.native.prompt).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("rejects a connection that moved off the displayed branch before the owner poll", async () => {
    const f = nativeFixture();
    const onBranch = (_slot: RuntimeSlot, leaf: string | null) =>
      leaf === "branch-a";
    const { slot, external } = await directAttachment(async () => f.native, {
      corresponds: onBranch,
      continues: onBranch,
    });
    f.setState({ status: "idle", leafId: "branch-a" });
    try {
      expect(await external.connect(slot)).toBe(true);
      f.setState({ status: "idle", leafId: "branch-b" });
      expect(await external.connect(slot)).toBe(false);
      expect(external.has(slot)).toBe(false);
      expect(f.native.prompt).not.toHaveBeenCalled();
    } finally {
      external.close();
    }
  });

  it("loads a reported continuation before revalidating its attachment", async () => {
    const f = nativeFixture();
    const known = new Set(["old"]);
    const reconcile = vi.fn(async () => {
      known.add("continued");
    });
    const connect = vi.fn(async () => f.native);
    const { slot, external } = await directAttachment(connect, {
      reconcile,
      corresponds: (_slot, leaf) => leaf !== null && known.has(leaf),
    });
    f.setState({ status: "idle", leafId: "old" });
    try {
      expect(await external.connect(slot)).toBe(true);
      reconcile.mockClear();
      known.delete("continued");
      f.setState({ status: "working", leafId: "continued" });
      expect(await external.connect(slot)).toBe(true);
      expect(reconcile).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledOnce();
      expect(f.native.close).not.toHaveBeenCalled();
    } finally {
      external.close();
    }
  });

  it("does not take over a Pi whose live leaf is still behind the selected branch", async () => {
    const f = nativeFixture();
    const { slot, external } = await directAttachment(async () => f.native, {
      continues: (_slot, leaf) => leaf === "current",
    });
    f.setState({ status: "idle", leafId: "ancestor" });
    try {
      expect(await external.connect(slot)).toBe(false);
      expect(f.native.close).toHaveBeenCalledOnce();
      f.setState({ status: "working", leafId: "current" });
      expect(await external.connect(slot)).toBe(true);
    } finally {
      external.close();
    }
  });

  it("restores an addressed view read-only when a live Pi owns its branch", async () => {
    const f = nativeFixture();
    f.setState({ status: "working", leafId: null });
    const create = vi.fn(
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
    );
    const presence = vi.fn(async () => [null]);
    const runtime = attachedRuntime(
      async () => f.native,
      create,
    ).setExternalSessionPresence(presence);
    const release = runtime.retainSessionView("a");
    try {
      const snapshot = await runtime.snapshot("a");
      expect(snapshot.active?.readOnlyReason).toBe("external-active");
      expect(runtime.activeSessionId).toBeNull();
      expect(presence).toHaveBeenCalledExactlyOnceWith(
        "a",
        expect.any(String),
        true,
        expect.any(Function),
      );
      expect(create).not.toHaveBeenCalled();
      await expect(
        runtime.prompt({ sessionId: "a", message: "First input" }),
      ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });
      expect(presence).toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(f.native.prompt).not.toHaveBeenCalled();
    } finally {
      release();
      await runtime.close();
    }
  });

  it.each(["open", "reconnect"] as const)(
    "automatically attaches a sole idle Pi on %s",
    async (entry) => {
      const session = await persistedRecord("a");
      const f = nativeFixture();
      f.setState({ status: "idle", leafId: "u1" });
      const create = vi.fn(() => {
        throw new Error("must not launch Pi");
      });
      const runtime = new RuntimeController(
        catalog([session]),
        trackedAttachmentStore(),
        {
          createProcess: create,
        },
      )
        .setExternalSessionPresence(async () => ["u1"])
        .setExternalSessionConnector(async (_id, _file, match, idleOnly) => {
          expect(idleOnly).toBe(true);
          expect(match("u1")).toBe("continues");
          return f.native;
        });
      const release = runtime.retainSessionView("a");
      try {
        if (entry === "open") await runtime.openSession("a");
        else await runtime.snapshot("a");
        await vi.waitFor(async () => {
          const snapshot = await runtime.snapshot("a");
          expect(snapshot.active?.readOnlyReason).toBeUndefined();
          expect(snapshot.sessionStatuses.a?.external).toBe(true);
        });
        expect(create).not.toHaveBeenCalled();
        if (entry === "reconnect") expect(runtime.activeSessionId).toBeNull();
      } finally {
        release();
        await runtime.close();
      }
    },
  );

  it("opens the current branch when the live Pi confirms it is still on an older node", async () => {
    const session = await persistedRecord("a");
    await appendFile(session.path, branchMessage("saved-current", "u1"));
    const create = vi.fn(
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
    );
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        createProcess: create,
      },
    ).setExternalSessionPresence(async (_id, _file, _fresh, isAncestor) => {
      expect(isAncestor("u1")).toBe(true);
      return ["u1"];
    });
    try {
      const preview = await runtime.openSession("a");
      expect(preview.active?.effectiveLeafId).toBe("saved-current");
      await waitForReady(runtime);
      expect(create).toHaveBeenCalledOnce();
      const snapshot = await runtime.snapshot("a");
      expect(snapshot.active?.readOnlyReason).toBeUndefined();
      expect(snapshot.active?.effectiveLeafId).toBe("saved-current");
    } finally {
      await runtime.close();
    }
  });

  it("leaves takeover manual when the selected Pi started work after reporting idle", async () => {
    const session = await persistedRecord("a");
    const f = nativeFixture();
    f.setState({ status: "working", leafId: "u1" });
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        createProcess: () => {
          throw new Error("must not launch Pi");
        },
      },
    )
      .setExternalSessionPresence(async () => ["u1"])
      .setExternalSessionConnector(async (_id, _file, _match, idleOnly) => {
        expect(idleOnly).toBe(true);
        return f.native;
      });
    const release = runtime.retainSessionView("a");
    try {
      const snapshot = await runtime.snapshot("a");
      expect(snapshot.active?.readOnlyReason).toBe("external-active");
      expect(f.native.close).toHaveBeenCalledOnce();
    } finally {
      release();
      await runtime.close();
    }
  });

  it.each([null, "not-in-projection", undefined])(
    "keeps a live Pi with unavailable attachment and leaf %s read-only",
    async (leaf) => {
      const presence = vi.fn(async () => [leaf]);
      const connect = vi.fn(async () => null);
      const create = vi.fn(
        (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      );
      const runtime = attachedRuntime(
        connect,
        create,
      ).setExternalSessionPresence(presence);
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
    const runtime = attachedRuntime(
      async () => null,
      create,
    ).setExternalSessionPresence(async () => {
      throw new Error("Cannot read registry");
    });
    try {
      await runtime.snapshot("a");
      await expect(
        runtime.prompt({ sessionId: "a", message: "First input" }),
      ).rejects.toMatchObject({ code: "EXTERNAL_PI_PRESENCE_UNAVAILABLE" });
      expect(create).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("fences a new external leaf reported during writer preparation", async () => {
    const workers: FakeRpc[] = [];
    const runtime = attachedRuntime(
      async () => null,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
    ).setExternalSessionPresence(
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
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      trackedAttachmentStore(),
      {
        createProcess: (options) => {
          const worker = new FakeRpc(options);
          workers.push(worker);
          return worker as unknown as PiRpcProcess;
        },
        openSessionProjection: preview,
      },
    )
      .setExternalSessionPresence(async () => live)
      .setExternalSessionConnector(async () => null);
    try {
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
    } finally {
      await runtime.close();
    }
  });

  it("observes short native run outcomes without replaying the initial report or claiming idle means success", async () => {
    const f = nativeFixture();
    const old = {
      id: "old",
      outcome: "completed" as const,
      settledAt: Date.now(),
    };
    const runs = { instanceId: "receiver", activeRunId: null, settled: [old] };
    f.setState({ status: "idle", taskRuns: runs });
    const runtime = attachedRuntime(async () => f.native);
    const events: Record<string, unknown>[] = [];
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );
    try {
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

  it("keeps a cold settings mutation read-only while another Pi continues the branch", async () => {
    const f = nativeFixture();
    const create = vi.fn(() => {
      throw new Error("must not launch Pi");
    });
    const connect = vi.fn(async () => f.native);
    const runtime = attachedRuntime(connect, create);
    try {
      await runtime.snapshot("a");
      // A live Pi continues this branch: no worker starts and nothing
      // attaches until the user takes over.
      await expect(
        runtime.setModel("a", "test", "model"),
      ).rejects.toMatchObject({
        status: 409,
        code: "EXTERNAL_PI_WRITER_ACTIVE",
      });
      expect(connect).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("fails a takeover whose Pi cannot be read without locking or launching, and attaches on retry", async () => {
    const f = nativeFixture();
    const create = vi.fn(() => {
      throw new Error("must not launch Pi");
    });
    vi.mocked(f.native.read).mockRejectedValue(
      new Error("Control endpoint unavailable"),
    );
    const runtime = attachedRuntime(async () => f.native, create);
    try {
      await expect(openAttached(runtime, "a")).rejects.toThrow(
        "Control endpoint unavailable",
      );
      // Still the ordinary view of a session another Pi is running.
      expect((await runtime.snapshot("a")).active?.readOnlyReason).toBe(
        "external-active",
      );
      expect(f.native.close).toHaveBeenCalled();
      vi.mocked(f.native.read).mockResolvedValue({ status: "idle" });
      await runtime.takeOverSession("a");
      expect(
        (await runtime.snapshot("a")).active?.readOnlyReason,
      ).toBeUndefined();
      await runtime.prompt({ sessionId: "a", message: "Attached input" });
      expect(f.native.prompt).toHaveBeenCalledOnce();
      expect(create).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("keeps an attachment writable through transient read failures", async () => {
    const f = nativeFixture();
    const create = vi.fn(() => {
      throw new Error("must keep the attached Pi");
    });
    const runtime = attachedRuntime(async () => f.native, create);
    try {
      await openAttached(runtime, "a");
      vi.mocked(f.native.read).mockRejectedValue(new Error("reloading"));
      const reads = vi.mocked(f.native.read).mock.calls.length;
      await vi.waitFor(
        () =>
          expect(vi.mocked(f.native.read).mock.calls.length).toBeGreaterThan(
            reads,
          ),
        { timeout: 2_000 },
      );
      expect(
        (await runtime.snapshot("a")).active?.readOnlyReason,
      ).toBeUndefined();
      vi.mocked(f.native.read).mockResolvedValue({ status: "idle" });
      await runtime.prompt({ sessionId: "a", message: "Still attached" });
      expect(f.native.prompt).toHaveBeenCalledOnce();
      expect(f.native.close).not.toHaveBeenCalled();
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
    const runtime = attachedRuntime(async () => f.native, create);
    try {
      await openAttached(runtime, "a");
      await runtime.prompt({ sessionId: "a", message: "Continue here" });
      expect(f.native.prompt).toHaveBeenCalledWith(
        "Continue here",
        undefined,
        expect.any(Function),
        undefined,
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

  it.each(["!pwd", "!!pwd", "/unknown-command"])(
    "rejects attached command %s before it can become a prompt",
    async (message) => {
      const f = nativeFixture();
      const runtime = attachedRuntime(async () => f.native);
      try {
        await openAttached(runtime, "a");
        await expect(
          runtime.prompt({ sessionId: "a", message }),
        ).rejects.toMatchObject({ code: "NATIVE_ACTION_UNSUPPORTED" });
        expect(f.native.prompt).not.toHaveBeenCalled();
      } finally {
        await runtime.close();
      }
    },
  );

  it("rejects input for a retired attachment instead of sending to its replacement", async () => {
    const first = nativeFixture();
    const replacement = nativeFixture();
    const connect = vi
      .fn()
      .mockResolvedValueOnce(first.native)
      .mockResolvedValue(replacement.native);
    const runtime = attachedRuntime(connect);
    try {
      await openAttached(runtime, "a");
      first.setState({ ended: "exited" });
      await expect(
        runtime.prompt({ sessionId: "a", message: "First Pi only" }),
      ).rejects.toMatchObject({ status: 409 });
      expect(first.native.close).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledOnce();
      expect(first.native.prompt).not.toHaveBeenCalled();
      expect(replacement.native.prompt).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
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
      const create = vi.fn(
        (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      );
      const runtime = attachedRuntime(connect, create);
      try {
        await openAttached(runtime, "a");
        first.setState({ ended: "exited" });
        const mutation =
          action === "rename"
            ? runtime.rename("a", "Original Pi")
            : action === "setModel"
              ? runtime.setModel("a", "native", "model")
              : runtime.setThinkingLevel("a", "high");
        await expect(mutation).rejects.toMatchObject({ status: 409 });
        expect(connect).toHaveBeenCalledOnce();
        expect(create).not.toHaveBeenCalled();
        expect(first.native[action]).not.toHaveBeenCalled();
        expect(replacement.native[action]).not.toHaveBeenCalled();
      } finally {
        await runtime.close();
      }
    },
  );

  it("rejects input for a cold view superseded by a pending branch selection", async () => {
    const session = await persistedRecord("a");
    await appendFile(session.path, branchMessage("old-branch", "u1"));
    const scanning = deferredSignal();
    const finish = deferredSignal();
    let pause = false;
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        createProcess: (options) => {
          const worker = new FakeRpc(options);
          workers.push(worker);
          return worker as unknown as PiRpcProcess;
        },
      },
    )
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

  it("keeps the attachment if a running session cannot switch branches", async () => {
    const session = await persistedRecord("a");
    await appendFile(
      session.path,
      branchMessage("other", "u1") + branchMessage("chosen", "u1"),
    );
    const f = nativeFixture();
    f.setState({ status: "working", leafId: "chosen" });
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        createProcess: () => {
          throw new Error("must not create Pi");
        },
      },
    )
      .setExternalSessionPresence(async () => ["chosen", "other"])
      .setExternalSessionConnector(async (_id, _file, _match, idleOnly) =>
        idleOnly ? null : f.native,
      );
    try {
      await openAttached(runtime, "a");
      await expect(runtime.selectBranch("a", "other")).rejects.toMatchObject({
        status: 409,
      });
      expect(f.native.close).not.toHaveBeenCalled();
      const after = await runtime.snapshot("a");
      expect(after.sessionStatuses.a?.external).toBe(true);
      expect(after.runState).toBe("running");
      expect(after.active?.effectiveLeafId).toBe("chosen");
    } finally {
      await runtime.close();
    }
  });

  it("validates recalled artifacts against the attached leaf", async () => {
    const session = await persistedRecord("a");
    await appendFile(
      session.path,
      branchMessage("other", "u1") + branchMessage("chosen", "u1"),
    );
    const f = nativeFixture();
    f.setState({ status: "idle", leafId: "chosen" });
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        createProcess: () => {
          throw new Error("must not create Pi");
        },
      },
    )
      .setExternalSessionPresence(async () => ["chosen", "other"])
      .setExternalSessionConnector(async () => f.native);
    try {
      await openAttached(runtime, "a");
      await appendFile(session.path, branchMessage("other-tip", "other"));
      const { active } = await runtime.snapshot("a");
      expect(active?.effectiveLeafId).toBe("chosen");
      expect(active?.durableLeafId).toBe("other-tip");
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
    } finally {
      await runtime.close();
    }
  });

  it("does not send from the default branch when restoring the attached leaf fails", async () => {
    const session = await persistedRecord("a");
    await appendFile(
      session.path,
      branchMessage("other", "u1") + branchMessage("chosen", "u1"),
    );
    const f = nativeFixture();
    f.setState({ status: "idle", leafId: "chosen" });
    let live = true;
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        createProcess: (options) => {
          const worker = new FakeRpc(options);
          worker.failPrompts = true;
          workers.push(worker);
          return worker as unknown as PiRpcProcess;
        },
      },
    )
      .setExternalSessionPresence(async () => (live ? ["chosen"] : []))
      .setExternalSessionConnector(async () => f.native);
    try {
      await openAttached(runtime, "a");
      await appendFile(session.path, branchMessage("other-tip", "other"));
      f.setState({ ended: "exited" });
      live = false;
      await expect(
        runtime.prompt({ sessionId: "a", message: "For chosen branch" }),
      ).rejects.toThrow("The external Pi connection has ended");
      await expect(
        runtime.prompt({ sessionId: "a", message: "For chosen branch" }),
      ).rejects.toThrow("prompt rejected");
      expect(workers).toHaveLength(1);
      expect(workers[0]!.stops).toBeGreaterThan(0);
      expect(workers[0]!.commands).not.toContainEqual({
        type: "prompt",
        message: "For chosen branch",
      });
      const { active } = await runtime.snapshot("a");
      expect(active?.effectiveLeafId).toBe("chosen");
      expect(active?.durableLeafId).toBe("other-tip");
    } finally {
      await runtime.close();
    }
  });

  it("discards late native state after retirement and completes writer recovery", async () => {
    const f = nativeFixture();
    const entered = deferredSignal();
    const proceed = deferredSignal();
    let retired = false;
    const worker = vi.fn(
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
    );
    const runtime = attachedRuntime(
      async () => (retired ? null : f.native),
      worker,
    ).setExternalSessionPresence(async () => (retired ? [] : [null]));
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
        return { status: "working" };
      });
      await runtime.openSession("a");
      await entered.promise;
      retired = true;
      f.setState({ ended: "exited" });
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
    const runtime = attachedRuntime(async () => f.native);
    try {
      await openAttached(runtime, "a");
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

  it("keeps a takeover's prompt addressed to its session while another is selected", async () => {
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
      {
        createProcess: (options) => {
          const worker = new FakeRpc(options);
          workers.push(worker);
          return worker as unknown as PiRpcProcess;
        },
        openSessionProjection: preview,
      },
    )
      .setExternalSessionPresence(async (id) => (id === "a" ? [null] : []))
      .setExternalSessionConnector(connect);
    try {
      const taking = openAttached(runtime, "a");
      await vi.waitFor(() => expect(connect).toHaveBeenCalled());
      gate.resolve();
      await taking;
      const sending = runtime.prompt({ sessionId: "a", message: "For A only" });
      await runtime.openSession("b");
      await sending;
      expect(connect.mock.calls.filter(([id]) => id === "a")).toHaveLength(1);
      expect(runtime.activeSessionId).toBe("b");
      expect(workers.every((worker) => worker.sessionId === "b")).toBe(true);
      expect(f.native.prompt).toHaveBeenCalledWith(
        "For A only",
        undefined,
        expect.any(Function),
        undefined,
        undefined,
      );
    } finally {
      gate.resolve();
      await runtime.close();
    }
  });

  it("follows a Pi that reports its new leaf after the append was already read", async () => {
    const session = await persistedRecord("a");
    const f = nativeFixture();
    f.setState({ status: "working", leafId: "u1" });
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        createProcess: () => {
          throw new Error("must not launch Pi");
        },
      },
    )
      .setExternalSessionPresence(async () => ["u1"])
      .setExternalSessionConnector(async (_id, _file, _match, idleOnly) =>
        idleOnly ? null : f.native,
      );
    const events: Array<{ type: string; sessionId: string }> = [];
    runtime.on("event", (event) => events.push(event));
    try {
      const attached = await openAttached(runtime, "a");
      expect(attached.sessionStatuses.a?.external).toBe(true);
      const replyId = "native-reply";
      await appendFile(
        session.path,
        `${JSON.stringify({
          type: "message",
          id: replyId,
          parentId: "u1",
          timestamp: session.created.toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Reply from the attached Pi" }],
            timestamp: 2,
          },
        })}\n`,
      );
      const saved = await runtime.snapshot("a");
      expect(saved.active?.durableLeafId).toBe(replyId);
      expect(saved.active?.projectionConflict).toBeNull();

      events.length = 0;
      f.setState({ status: "working", leafId: replyId });
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
      {
        createProcess: () => {
          throw new Error("must not launch Pi");
        },
        openSessionProjection: preview,
      },
    )
      .setExternalSessionPresence(async () => [null])
      .setExternalSessionConnector(async () => f.native);
    try {
      await openAttached(runtime, "a");
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
      {
        createProcess: () => {
          throw new Error("must not launch Pi");
        },
        openSessionProjection: preview,
      },
    )
      .setExternalSessionPresence(async () => [null])
      .setExternalSessionConnector(async () => f.native);
    vi.mocked(f.native.prompt).mockImplementationOnce(
      async (_text, _behavior, _beforeSend, images) => {
        expect(images).toHaveLength(1);
        expect(await readFile(images![0]!.path, "utf8")).toBe("pixels");
        throw new Error("Native question is waiting");
      },
    );
    try {
      await openAttached(runtime, "a");
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

  it("retains transport image copies after a lost receipt and restages originals", async () => {
    const store = trackedAttachmentStore();
    const [image, file] = await store.addMany([
      {
        originalname: "image.png",
        mimetype: "image/png",
        size: 6,
        buffer: Buffer.from("pixels"),
      } as Express.Multer.File,
      {
        originalname: "notes.txt",
        mimetype: "text/plain",
        size: 5,
        buffer: Buffer.from("notes"),
      } as Express.Multer.File,
    ]);
    const f = nativeFixture();
    vi.mocked(f.native.prompt).mockRejectedValue(
      Object.assign(new Error("Receipt lost"), { outcomeUnknown: true }),
    );
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      {
        createProcess: () => {
          throw new Error("must not launch Pi");
        },
        openSessionProjection: preview,
      },
    )
      .setExternalSessionPresence(async () => [null])
      .setExternalSessionConnector(async () => f.native);
    try {
      await openAttached(runtime, "a");
      const attachmentIds = [image!.id, file!.id];
      await expect(
        runtime.prompt({
          sessionId: "a",
          message: "Read this",
          attachmentIds,
        }),
      ).rejects.toMatchObject({ outcomeUnknown: true });
      const [message, , , images] = vi.mocked(f.native.prompt).mock.calls[0]!;
      const imagePath = images![0]!.path;
      const filePath = parseAttachmentContext(message, 1).references[0]!;
      expect((await store.imagePreview(image!.id)).bytes.toString()).toBe(
        "pixels",
      );
      expect((await store.resolveForPrompt(attachmentIds)).files).toHaveLength(
        2,
      );
      store.restage(attachmentIds);
      await store.remove(image!.id);
      await store.remove(file!.id);
      expect(await readFile(imagePath, "utf8")).toBe("pixels");
      expect(await readFile(filePath, "utf8")).toBe("notes");
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
      expect(await readFile(filePath, "utf8")).toBe("notes");
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

  it("retains the attached branch while observing background work", async () => {
    const f = nativeFixture();
    f.setState({ status: "working" });
    const diagnostics = nullDiagnosticLogger();
    const log = vi.spyOn(diagnostics, "record");
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      trackedAttachmentStore(),
      {
        createProcess: () => {
          throw new Error("must not launch Pi");
        },
        openSessionProjection: preview,
        branchBridgeTimeoutMs: 15_000,
        diagnostics,
      },
    )
      .setExternalSessionPresence(async () => [null])
      .setExternalSessionConnector(async (id, _file, _match, idleOnly) => {
        if (id === "a") return idleOnly ? null : f.native;
        return nativeFixture().native;
      });
    try {
      await openAttached(runtime, "a");
      await vi.waitFor(async () =>
        expect((await runtime.snapshot("a")).runState).toBe("running"),
      );
      const slots = (runtime as unknown as { slots: Map<string, RuntimeSlot> })
        .slots;
      await openAttached(runtime, "b");
      await vi.waitFor(() => expect(slots.get("a")?.projection).not.toBeNull());
      const reads = vi.mocked(f.native.read).mock.calls.length;
      await vi.waitFor(
        () =>
          expect(
            vi.mocked(f.native.read).mock.calls.length,
          ).toBeGreaterThanOrEqual(reads + 2),
        { timeout: 2_500 },
      );
      expect(slots.get("a")?.projection).not.toBeNull();
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
    f.setState({ status: "idle", leafId: "u1" });
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        createProcess: () => {
          throw new Error("must not launch Pi");
        },
      },
    )
      .setExternalSessionPresence(async () => [null])
      .setExternalSessionConnector(async () => f.native);
    try {
      await openAttached(runtime, "a");
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
    "ends connected native %s instances before deleting their sessions singly and through Hidden",
    async (status) => {
      const sessions = [await persistedRecord("a"), await persistedRecord("b")];
      const connections = [nativeFixture(), nativeFixture()];
      for (const connection of connections)
        connection.setState({ status, leafId: "u1" });
      const stopped = new Set<string>();
      const remove = vi.fn(async (session) => {
        expect(stopped.has(session.id)).toBe(true);
        return "trashed" as const;
      });
      const runtime = new RuntimeController(
        catalog(sessions),
        trackedAttachmentStore(),
        {
          createProcess: () => {
            throw new Error("must not launch Pi");
          },
          branchBridgeTimeoutMs: 15_000,
          deleteSessionRecord: remove,
        },
      )
        .setExternalSessionPresence(async () => [null])
        .setExternalSessionConnector(
          async (id) => connections[id === "a" ? 0 : 1]!.native,
        )
        .setExternalSessionTerminator(async (id) => {
          stopped.add(id);
        });
      try {
        await openAttached(runtime, "a");
        await vi.waitFor(async () =>
          expect((await runtime.snapshot("a")).sessionStatuses.a).toMatchObject(
            { external: true, runState: "running" },
          ),
        );
        await expect(runtime.deleteSession("a")).resolves.toMatchObject({
          disposition: "trashed",
        });
        await openAttached(runtime, "b");
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
    "ends an in-flight native %s before moving its session",
    async (operation) => {
      const f = nativeFixture();
      f.setState({ status: "idle", leafId: "u1" });
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
      else if (operation === "rename")
        vi.mocked(f.native.rename!).mockImplementation(hold);
      else vi.mocked(f.native.prompt).mockImplementation(hold);
      const remove = vi.fn(async () => "trashed" as const);
      const runtime = new RuntimeController(
        catalog([await persistedRecord("a")]),
        trackedAttachmentStore(),
        {
          createProcess: () => {
            throw new Error("must not launch Pi");
          },
          branchBridgeTimeoutMs: 15_000,
          deleteSessionRecord: remove,
        },
      )
        .setExternalSessionPresence(async () => [null])
        .setExternalSessionConnector(async () => f.native);
      try {
        await openAttached(runtime, "a");
        await vi.waitFor(() => expect(f.native.read).toHaveBeenCalled());
        const sending =
          operation === "prompt"
            ? runtime.prompt({ sessionId: "a", message: "Hold" })
            : operation === "rename"
              ? runtime.rename("a", "Hold")
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
    f.setState({ status: "idle", modelSelection: old });
    f.native.models = vi.fn(async () => {
      await gate.promise;
      return { ...old, models };
    });
    f.native.setModel = vi.fn(async () => ({
      ...selected,
      thinkingLevel: "off" as const,
    }));
    f.native.setThinkingLevel = vi.fn(async () => selected);
    const { slot, external } = await directAttachment(async () => f.native);
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

  it.each(["poll", "reselect"] as const)(
    "preserves completed model/thinking changes when an older %s observation returns last",
    async (source) => {
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
      f.setState({ status: "idle", modelSelection: old });
      f.native.models = vi.fn();
      f.native.setModel = vi.fn(async () => ({
        ...selected,
        thinkingLevel: "off" as const,
      }));
      f.native.setThinkingLevel = vi.fn(async () => selected);
      const { slot, external } = await directAttachment(
        async () => f.native,
        {},
        10,
      );
      vi.useFakeTimers();
      try {
        await external.connect(slot);
        vi.mocked(f.native.read).mockImplementationOnce(async () => {
          // The receiver report was read before the selection, while its
          // asynchronous ownership validation is still in flight.
          const state = {
            status: "working" as const,
            modelSelection: old,
          };
          await gate.promise;
          return state;
        });
        const reading =
          source === "reselect" ? external.connect(slot) : undefined;
        if (source === "poll") await vi.advanceTimersByTimeAsync(10);
        expect(f.native.read).toHaveBeenCalledTimes(2);
        await external.setModel(slot, "native", "selected");
        await external.setThinkingLevel(slot, "low");
        gate.resolve();
        await reading;
        await vi.advanceTimersByTimeAsync(0);
        expect(external.modelSelection(slot)).toEqual(selected);
        // Unrelated activity still updates; only the stale selection is fenced.
        expect(slot.runState).toBe("running");
        f.setState({
          status: "idle",
          modelSelection: old,
        });
        await vi.advanceTimersByTimeAsync(10);
        // A subsequent terminal-side selection remains authoritative.
        expect(external.modelSelection(slot)).toEqual(old);
      } finally {
        gate.resolve();
        external.close();
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

  it("retires an old receiver's catalog while retaining the native Pi connection", async () => {
    const f = await nativeModelFixture();
    const gate = deferredSignal();
    const oldModel = { provider: "old", id: "retired" };
    const freshModel = { provider: "fresh", id: "available" };
    vi.mocked(f.native.models)
      .mockImplementationOnce(async () => {
        await gate.promise;
        return { ...f.selection, models: [oldModel] };
      })
      .mockResolvedValue({ ...f.selection, models: [freshModel] });
    vi.useFakeTimers();
    try {
      await f.external.connect(f.slot);
      const pending = f.external.models(f.slot);
      const outcome = pending.catch((error: unknown) => error);
      f.emit.mockClear();
      f.setState({
        ...f.state,
        taskRuns: {
          instanceId: "receiver-two",
          activeRunId: null,
          settled: [],
        },
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(f.slot.availableModels).toBeNull();
      expect(f.emit).toHaveBeenCalledWith(f.slot, {
        type: "model_metadata_changed",
      });
      // The replacement's read can finish without waiting for the old reply.
      await expect(f.external.models(f.slot)).resolves.toMatchObject({
        models: [freshModel],
      });
      gate.resolve();
      expect(await outcome).toMatchObject({ status: 409 });
      expect(f.slot.availableModels).toEqual([freshModel]);
      expect(f.native.close).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      f.external.close();
      vi.useRealTimers();
    }
  });

  it.each(["model", "thinking"] as const)(
    "rejects a retired receiver's %s result without replacing its successor's selection",
    async (kind) => {
      const f = await nativeModelFixture();
      const gate = deferredSignal();
      const successor = {
        model: { provider: "native", id: "successor" },
        thinkingLevel: "high" as const,
      };
      const late = async () => {
        await gate.promise;
        return f.selection;
      };
      vi.mocked(f.native.setModel).mockImplementation(late);
      vi.mocked(f.native.setThinkingLevel).mockImplementation(late);
      vi.useFakeTimers();
      try {
        await f.external.connect(f.slot);
        const pending =
          kind === "model"
            ? f.external.setModel(f.slot, "native", "current")
            : f.external.setThinkingLevel(f.slot, "low");
        const outcome = pending.catch((error: unknown) => error);
        f.setState({
          ...f.state,
          modelSelection: successor,
          taskRuns: {
            instanceId: "receiver-two",
            activeRunId: null,
            settled: [],
          },
        });
        await vi.advanceTimersByTimeAsync(10);
        gate.resolve();
        expect(await outcome).toMatchObject({ status: 409 });
        expect(f.external.modelSelection(f.slot)).toEqual(successor);
        expect(f.native.close).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        f.external.close();
        vi.useRealTimers();
      }
    },
  );

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
      f.setState({ status: "idle" });
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
    ["exited", { ended: "exited" }, true],
    ["left-session", { ended: "left-session" }, true],
    ["unreachable", { ended: "unreachable" }, true],
    ["left-branch", { status: "working", leafId: "elsewhere" }, false],
  ] as const)(
    "ends a busy attachment that %s without claiming its task failed",
    async (reason, observed, stillOnBranch) => {
      const f = await nativeModelFixture();
      let onBranch = true;
      const released = vi.fn();
      const { slot, external } = await directAttachment(
        async () => f.native,
        {
          emit: f.emit,
          released,
          corresponds: () => onBranch,
        },
        10,
      );
      vi.useFakeTimers();
      try {
        f.setState({ ...f.state, status: "working" });
        await external.connect(slot);
        expect(slot.runState).toBe("running");
        f.setState(observed);
        onBranch = stillOnBranch;
        await vi.advanceTimersByTimeAsync(20);
        expect(external.has(slot)).toBe(false);
        expect(slot.runState).toBe("idle");
        expect(f.emit).toHaveBeenCalledWith(slot, {
          type: "external_attachment_ended",
          reason,
          duringWork: true,
        });
        expect(f.emit).not.toHaveBeenCalledWith(
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
    try {
      await openAttached(runtime, "a");
      await runtime.prompt({ sessionId: "a", message: "First" });
      first.setState({ ended: "exited" });
      await vi.waitFor(
        () => expect(first.native.close).toHaveBeenCalledOnce(),
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
        undefined,
      );
    } finally {
      await runtime.close();
    }
  });

  it("closes only its connection while a takeover is in flight", async () => {
    const f = nativeFixture();
    const gate = deferredSignal();
    const connect = vi.fn(async () => {
      await gate.promise;
      return f.native;
    });
    const runtime = attachedRuntime(connect, () => {
      throw new Error("must not launch Pi after close");
    });
    const taking = openAttached(runtime, "a").catch(() => undefined);
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
    const closing = runtime.close();
    gate.resolve();
    await closing;
    await taking;
    expect(f.native.close).toHaveBeenCalledOnce();
    expect(f.native.prompt).not.toHaveBeenCalled();
  });
});
