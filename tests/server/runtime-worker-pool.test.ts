import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type PiRpcProcess } from "../../server/pi-rpc.js";

import { MAX_IDLE_WORKERS, RuntimeController } from "../../server/runtime.js";

import {
  FakeRpc,
  record,
  waitForReady,
  preview,
  catalog,
  trackedAttachmentStore,
  deferredSignal,
  initializeRuntimeFixture,
  disposeRuntimeFixture,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("worker and projection retention", () => {
  it("keeps an accepted prompt non-evictable until its lifecycle event arrives", async () => {
    const store = trackedAttachmentStore();
    const ids = ["a", "b", "c", "d", "e", "f"];
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog(ids.map((id) => record(id, "/tmp"))),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    for (const id of ids.slice(0, 4)) await runtime.openSession(id);
    await runtime.prompt({
      sessionId: "a",
      message: "accepted before agent_start",
    });
    await runtime.openSession("e");
    await runtime.openSession("f");

    await vi.waitFor(() =>
      expect(workers.find((worker) => worker.sessionId === "b")?.stops).toBe(1),
    );
    expect(workers.find((worker) => worker.sessionId === "a")?.stops).toBe(0);
    expect((await runtime.snapshot()).sessionStatuses.a).toMatchObject({
      runState: "queued",
      indicator: "running",
    });
    await runtime.close();
  });

  it("keeps an extension-response worker protected until Pi acknowledges the ordered input", async () => {
    const store = trackedAttachmentStore();
    const ids = ["a", "b", "c", "d", "e", "f"];
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog(ids.map((id) => record(id, "/project"))),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    for (const id of ids.slice(0, 4)) await runtime.openSession(id);
    const workerA = workers.find((worker) => worker.sessionId === "a")!;
    workerA.emit("event", {
      type: "extension_ui_request",
      id: "question-a",
      method: "confirm",
    });

    const { promise: ackGate, resolve: releaseAck } = deferredSignal();
    const { promise: started, resolve: ackStarted } = deferredSignal();
    const request = workerA.request.bind(workerA);
    workerA.request = async <T>(
      command: Record<string, unknown>,
    ): Promise<T> => {
      if (command.type === "get_state") {
        ackStarted();
        await ackGate;
      }
      return request<T>(command);
    };

    const responding = runtime.extensionUiResponse({
      sessionId: "a",
      id: "question-a",
      confirmed: true,
    });
    await started;
    await runtime.openSession("e");
    await runtime.openSession("f");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(workerA.stops).toBe(0);

    releaseAck();
    await responding;
    expect(workerA.uiResponses).toEqual([
      { id: "question-a", confirmed: true },
    ]);
    await runtime.close();
  });

  it("bounds the idle worker cache without stopping busy, queued, or extension-blocked sessions", async () => {
    const store = trackedAttachmentStore();
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const workers: FakeRpc[] = [];
    const previewCalls = new Map<string, number>();
    const runtime = new RuntimeController(
      catalog(ids.map((id) => record(id, "/project"))),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      async (session) => {
        previewCalls.set(session.id, (previewCalls.get(session.id) ?? 0) + 1);
        return preview(session);
      },
    );

    await runtime.openSession("a");
    await waitForReady(runtime, "a");
    workers[0]!.emit("event", { type: "agent_start" });
    await runtime.openSession("b");
    await waitForReady(runtime, "b");
    workers[1]!.emit("event", {
      type: "extension_ui_request",
      id: "question-b",
      method: "confirm",
    });
    await runtime.openSession("c");
    await waitForReady(runtime, "c");
    workers[2]!.emit("event", {
      type: "queue_update",
      steering: ["parked"],
      followUp: [],
    });
    for (const id of ids.slice(3)) await runtime.openSession(id);

    await vi.waitFor(() =>
      expect(workers.filter((worker) => worker.stops === 0)).toHaveLength(
        MAX_IDLE_WORKERS + 4,
      ),
    );
    expect(workers[0]!.stops).toBe(0); // busy
    expect(workers[1]!.stops).toBe(0); // awaiting extension input
    expect(workers[2]!.stops).toBe(0); // queued input owns worker memory

    workers[0]!.emit("event", { type: "agent_settled" });
    await runtime.extensionUiResponse({
      sessionId: "b",
      id: "question-b",
      confirmed: true,
    });
    await vi.waitFor(() =>
      expect(workers.filter((worker) => worker.stops === 0)).toHaveLength(
        MAX_IDLE_WORKERS + 2,
      ),
    );
    expect(workers[2]!.stops).toBe(0);

    workers[2]!.emit("event", {
      type: "queue_update",
      steering: [],
      followUp: [],
    });
    await vi.waitFor(() =>
      expect(workers.filter((worker) => worker.stops === 0)).toHaveLength(
        MAX_IDLE_WORKERS + 1,
      ),
    );

    // Reopening a reclaimed session transparently starts one replacement,
    // after the previous process and sole projection have stopped.
    await runtime.openSession("c");
    await vi.waitFor(() =>
      expect(workers.filter((worker) => worker.sessionId === "c")).toHaveLength(
        2,
      ),
    );
    expect(
      workers
        .filter((worker) => worker.sessionId === "c")
        .map((worker) => worker.stops),
    ).toEqual([1, 0]);
    expect(previewCalls.get("c")).toBe(2);
    await runtime.close();
  });

  it("bounds dormant slots and status projection across hundreds of opens and reopens evicted sessions", async () => {
    const store = trackedAttachmentStore();
    const ids = Array.from({ length: 240 }, (_, index) => `session-${index}`);
    const workers: FakeRpc[] = [];
    const previewCalls = new Map<string, number>();
    const runtime = new RuntimeController(
      catalog(ids.map((id) => record(id, "/project"))),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      async (session) => {
        previewCalls.set(session.id, (previewCalls.get(session.id) ?? 0) + 1);
        return preview(session);
      },
    );
    for (const id of ids) await runtime.openSession(id);
    const slots = (runtime as unknown as { slots: Map<string, unknown> }).slots;
    await vi.waitFor(() =>
      expect(slots.size).toBeLessThanOrEqual(MAX_IDLE_WORKERS + 1),
    );
    const snapshot = await runtime.snapshot();
    expect(Object.keys(snapshot.sessionStatuses ?? {})).toHaveLength(
      slots.size,
    );
    expect(workers.filter((worker) => worker.stops === 0)).toHaveLength(
      MAX_IDLE_WORKERS + 1,
    );

    expect(slots.has(ids[0]!)).toBe(false);
    const workerCount = workers.length;
    const restored = await runtime.snapshot(ids[0]!);
    expect(restored.active?.sessionId).toBe(ids[0]);
    expect(workers).toHaveLength(workerCount);
    expect(previewCalls.get(ids[0]!)).toBe(2);
    expect((await runtime.snapshot()).active?.sessionId).toBe(ids.at(-1));

    const reopened = await runtime.openSession(ids[0]!);
    expect(reopened.active?.sessionId).toBe(ids[0]);
    await vi.waitFor(() =>
      expect(
        workers.filter((worker) => worker.sessionId === ids[0]),
      ).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(slots.size).toBeLessThanOrEqual(MAX_IDLE_WORKERS + 1),
    );
    await runtime.close();
  }, 30_000);

  it("reclaims processless failed projections while retaining lightweight status across hundreds of exits", async () => {
    const store = trackedAttachmentStore();
    const ids = Array.from({ length: 220 }, (_, index) => `failed-${index}`);
    const workers: FakeRpc[] = [];
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const runtime = new RuntimeController(
      catalog(ids.map((id) => record(id, "/tmp"))),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
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
    const store = trackedAttachmentStore();
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
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
    try {
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
        expect(
          workers.filter((worker) => worker.sessionId === "a"),
        ).toHaveLength(2),
      );
    } finally {
      await runtime.close();
    }
  });

  it("keeps a reconciliation conflict sticky across agent settlement", async () => {
    const store = trackedAttachmentStore();
    let worker: FakeRpc | undefined;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
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
    try {
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
    } finally {
      await runtime.close();
    }
  });
});
