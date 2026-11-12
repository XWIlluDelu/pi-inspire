import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type PiRpcProcess } from "../../server/pi-rpc.js";

import { MAX_IDLE_WORKERS, RuntimeController } from "../../server/runtime.js";

import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  initializeRuntimeFixture,
  persistedRecord,
  preview,
  record,
  schedulingRuntime,
  trackedAttachmentStore,
  trackRuntime,
  waitForReady,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("worker and projection retention", () => {
  it("retains cold views for every subscribing browser without selecting or starting a worker", async () => {
    const spawn = vi.fn(() => {
      throw new Error("Viewing must not launch Pi");
    });
    const sessions = await Promise.all(
      ["a", "b"].map((id) => persistedRecord(id)),
    );
    const runtime = new RuntimeController(
      catalog(sessions),
      trackedAttachmentStore(),
      {
        createProcess: spawn,
      },
    );
    const first = runtime.retainSessionView("a");
    const second = runtime.retainSessionView("a");
    const other = runtime.retainSessionView("b");
    try {
      const initial = await runtime.snapshot("a");
      await runtime.snapshot("b");
      await runtime.composerHistory("a");
      await expect(runtime.transcriptUserTurns("b")).resolves.toMatchObject({
        turns: [expect.objectContaining({ snippet: "persisted:b" })],
      });
      expect(runtime.activeSessionId).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
      const restart = runtime.reserveMaintenanceRestart();
      expect(restart.kind).toBe("ready");
      if (restart.kind === "ready")
        runtime.releaseMaintenanceRestart(restart.leaseId);
      expect((await runtime.snapshot("a")).active?.transcriptPage?.viewId).toBe(
        initial.active?.transcriptPage?.viewId,
      );

      first();
      first(); // One browser closing twice cannot release another's view.
      await expect(runtime.composerHistory("a")).resolves.toMatchObject({
        sessionId: "a",
      });
      second();
      const slots = (runtime as unknown as { slots: Map<string, unknown> })
        .slots;
      await vi.waitFor(() => expect(slots.has("a")).toBe(false));
      await expect(runtime.composerHistory("b")).resolves.toMatchObject({
        sessionId: "b",
      });
      other();
      await vi.waitFor(() => expect(slots.size).toBe(0));
    } finally {
      first();
      second();
      other();
      await runtime.close();
    }
  });

  it("reclaims only idle workers as browser views, prompts, and extension answers release them", async () => {
    const ids = [
      "busy",
      "dialog",
      "queued",
      "viewed",
      "idle",
      "f",
      "g",
      "h",
      "current",
    ];
    const { runtime, workers } = schedulingRuntime({
      sessions: ids.map((id) => record(id, "/project")),
    });
    const released = deferredSignal();
    let responding: Promise<void> | undefined;
    const releaseView = runtime.retainSessionView("viewed");
    const open = async (id: string) => {
      await runtime.openSession(id);
      await waitForReady(runtime, id);
    };
    const worker = (id: string) =>
      workers.find((item) => item.sessionId === id)!;
    const liveWorkers = () =>
      workers.filter((item) => item.stops === 0).map((item) => item.sessionId);

    try {
      await open("busy");
      worker("busy").emit("event", { type: "agent_start" });
      await open("dialog");
      const dialog = worker("dialog");
      dialog.emit("event", {
        type: "extension_ui_request",
        id: "question",
        method: "confirm",
      });
      await open("queued");
      await runtime.prompt({
        sessionId: "queued",
        message: "Before agent_start",
      });
      await open("viewed");
      for (const id of ids.slice(4, -1)) await open(id);
      await vi.waitFor(() => expect(liveWorkers()).toEqual(ids.slice(0, -1)));
      expect((await runtime.snapshot()).sessionStatuses.queued).toMatchObject({
        runState: "queued",
        indicator: "running",
      });

      const ackStarted = deferredSignal();
      dialog.responseOverrides.set("get_state", async () => {
        ackStarted.resolve();
        await released.promise;
        return { sessionId: "dialog", isStreaming: false };
      });
      responding = runtime.extensionUiResponse({
        sessionId: "dialog",
        id: "question",
        confirmed: true,
      });
      await ackStarted.promise;
      await open("current");
      await vi.waitFor(() =>
        expect(liveWorkers()).toEqual(ids.filter((id) => id !== "idle")),
      );

      worker("busy").emit("event", { type: "agent_settled" });
      releaseView();
      await vi.waitFor(() => {
        expect(liveWorkers()).toEqual([
          "dialog",
          "queued",
          "f",
          "g",
          "h",
          "current",
        ]);
      });
      released.resolve();
      await responding;
      expect(dialog.uiResponses).toEqual([{ id: "question", confirmed: true }]);

      worker("queued").emit("event", { type: "agent_start" });
      worker("queued").emit("event", {
        type: "queue_update",
        steering: ["parked"],
        followUp: [],
      });
      worker("queued").emit("event", { type: "agent_settled" });
      await vi.waitFor(() => {
        expect(liveWorkers()).toHaveLength(MAX_IDLE_WORKERS + 2);
        expect(worker("queued").stops).toBe(0);
      });
      worker("queued").emit("event", {
        type: "queue_update",
        steering: [],
        followUp: [],
      });
      await vi.waitFor(() => {
        expect(liveWorkers()).toHaveLength(MAX_IDLE_WORKERS + 1);
        expect(worker("queued").stops).toBe(1);
      });
      expect((await runtime.snapshot("queued")).active?.sessionId).toBe(
        "queued",
      );
      expect(runtime.activeSessionId).toBe("current");
      expect(liveWorkers()).not.toContain("queued");

      await open("queued");
      expect(
        workers
          .filter((item) => item.sessionId === "queued")
          .map((item) => item.stops),
      ).toEqual([1, 0]);
    } finally {
      released.resolve();
      await responding?.catch(() => undefined);
      releaseView();
      await runtime.close();
    }
  });

  it("reclaims failed projections while retaining their status after worker exit", async () => {
    const ids = Array.from(
      { length: MAX_IDLE_WORKERS + 2 },
      (_, index) => `failed-${index}`,
    );
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { runtime, workers } = schedulingRuntime({
      sessions: ids.map((id) => record(id, "/tmp")),
    });
    try {
      type ReclaimSlot = {
        projection: { close(): Promise<void> } | null;
        runState: string;
        ready: boolean;
      };
      const slots = (runtime as unknown as { slots: Map<string, ReclaimSlot> })
        .slots;
      let projectionsClosed = 0;
      for (const [index, id] of ids.entries()) {
        await runtime.openSession(id);
        await vi.waitFor(() => expect(slots.get(id)?.ready).toBe(true));
        const projection = slots.get(id)!.projection!;
        const close = projection.close.bind(projection);
        projection.close = async () => {
          projectionsClosed += 1;
          await close();
        };
        workers
          .find((worker) => worker.sessionId === id)!
          .emit("exit", new Error(`exit-${index}`));
      }
      await vi.waitFor(() =>
        expect(
          [...slots.values()].filter((slot) => slot.projection).length,
        ).toBeLessThanOrEqual(1),
      );
      expect(projectionsClosed).toBeGreaterThanOrEqual(ids.length - 1);
      expect(slots.size).toBe(ids.length);
      expect(
        [...slots.values()].every((slot) => slot.runState === "failed"),
      ).toBe(true);

      await runtime.openSession(ids[0]!);
      await vi.waitFor(() =>
        expect(
          workers.filter((worker) => worker.sessionId === ids[0]),
        ).toHaveLength(2),
      );
      expect(slots.get(ids[0]!)?.projection).toBeTruthy();
    } finally {
      errors.mockRestore();
      await runtime.close();
    }
  }, 30_000);

  it("reloads a reclaimed conflicted projection without starting a writer until abort clears policy", async () => {
    const { runtime, workers } = schedulingRuntime({
      sessions: [record("a", "/tmp"), record("b", "/tmp")],
    });
    type InternalSlot = {
      projection: unknown;
      conflict: {
        kind: "projection-failure";
        message: string;
        revision: number;
      } | null;
      runState: string;
      attention: "failed" | null;
      ready: boolean;
    };
    const slots = (runtime as unknown as { slots: Map<string, InternalSlot> })
      .slots;
    trackRuntime(runtime);
    await runtime.openSession("a");
    await vi.waitFor(() => expect(slots.get("a")?.ready).toBe(true));
    workers[0]!.emit("exit", new Error("conflicted exit"));
    const a = slots.get("a")!;
    a.conflict = {
      kind: "projection-failure",
      message: "retained conflict",
      revision: 1,
    };
    a.runState = "conflict";
    a.attention = "failed";

    await runtime.openSession("b");
    await vi.waitFor(() => expect(a.projection).toBeNull());
    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(a.projection).toBeTruthy();
    expect(a.conflict?.message).toBe("retained conflict");
    expect(workers.filter((worker) => worker.sessionId === "a")).toHaveLength(
      1,
    );

    await runtime.abort("a");
    expect(a.conflict).toBeNull();
    await runtime.prompt({ sessionId: "a", message: "after recovery" });
    await vi.waitFor(() =>
      expect(workers.filter((worker) => worker.sessionId === "a")).toHaveLength(
        2,
      ),
    );
  });

  it("keeps a reconciliation conflict sticky across agent settlement", async () => {
    const store = trackedAttachmentStore();
    let worker: FakeRpc | undefined;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      {
        createProcess: (options) => {
          worker = new FakeRpc(options);
          return worker as unknown as PiRpcProcess;
        },
        openSessionProjection: preview,
      },
    );
    type InternalSlot = {
      conflict: {
        kind: "external-change";
        message: string;
        revision: number;
      } | null;
      runState: string;
      ready: boolean;
    };
    const slots = (runtime as unknown as { slots: Map<string, InternalSlot> })
      .slots;
    trackRuntime(runtime);
    await runtime.openSession("a");
    await vi.waitFor(() => expect(worker?.starts).toBe(1));
    const slot = slots.get("a")!;
    slot.conflict = {
      kind: "external-change",
      message: "Session changed on disk",
      revision: 2,
    };
    slot.runState = "conflict";
    worker!.emit("event", { type: "agent_settled" });
    await vi.waitFor(() => expect(worker?.stops).toBe(1));
    expect(slot.conflict).toEqual({
      kind: "external-change",
      message: "Session changed on disk",
      revision: 2,
    });
    expect(slot.runState).toBe("conflict");
    await expect(
      runtime.prompt({ sessionId: "a", message: "must not restart" }),
    ).rejects.toThrow("Session changed on disk");
    expect(worker?.starts).toBe(1);
  });
});
