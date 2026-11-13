import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type RuntimeWorkerStatus } from "../../server/runtime.js";

import {
  deferredSignal,
  disposeRuntimeFixture,
  fakeRuntime,
  fixtureCwd,
  initializeRuntimeFixture,
  preview,
  record,
  schedulingRuntime,
  startWorker,
  trackRuntime,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("session selection and addressed reads", () => {
  it("keeps independent workers when viewing or mutating a different session", async () => {
    const { runtime, workers } = schedulingRuntime({
      sessions: [record("a", "/project/one"), record("b", "/project/two")],
    });
    trackRuntime(runtime);
    await runtime.openSession("a");
    await startWorker(runtime, "a");
    await runtime.openSession("b");
    await startWorker(runtime, "b");
    await runtime.prompt({
      sessionId: "a",
      message: "background instruction",
    });
    await runtime.rename("a", "renamed A");
    expect(runtime.startupSessionHint).toBe("b");
    expect(workers.map((worker) => worker.options.cwd)).toEqual([
      fixtureCwd("/project/one"),
      fixtureCwd("/project/two"),
    ]);
    const mutations = workers.map(({ commands }) =>
      commands.filter(
        ({ type }) => type === "prompt" || type === "set_session_name",
      ),
    );
    expect(mutations).toMatchObject([
      [
        { type: "prompt", message: "background instruction" },
        { type: "set_session_name", name: "renamed A" },
      ],
      [],
    ]);
    await runtime.openSession("a");
    expect(workers).toHaveLength(2);
    expect(workers.map(({ stops }) => stops)).toEqual([0, 0]);
  });

  it("does not change selection when a ready session's pre-commit snapshot fails", async () => {
    const { runtime, workers } = schedulingRuntime({
      sessions: [record("a", "/project"), record("b", "/project")],
    });
    await runtime.openSession("a");
    await startWorker(runtime);
    const slots = (
      runtime as unknown as { slots: Map<string, { ready: boolean }> }
    ).slots;
    await vi.waitFor(() => expect(slots.get("a")?.ready).toBe(true));
    await runtime.openSession("b");

    const workerA = workers.find((worker) => worker.sessionId === "a")!;
    const request = workerA.request.bind(workerA);
    workerA.request = async <T>(
      command: Record<string, unknown>,
    ): Promise<T> => {
      if (command.type === "get_state")
        throw new Error("snapshot failed before selection");
      return request<T>(command);
    };

    await expect(runtime.openSession("a")).rejects.toThrow(
      /snapshot failed before selection/,
    );
    expect(runtime.startupSessionHint).toBe("b");
    await runtime.close();
  });

  it("keeps the addressed snapshot while another browser opens a different session", async () => {
    const { runtime, workers } = schedulingRuntime({
      sessions: [record("a", "/project"), record("b", "/project")],
    });
    const restored = await runtime.snapshot("a");
    expect(restored.active?.sessionId).toBe("a");
    expect(runtime.startupSessionHint).toBeNull();
    expect(workers).toHaveLength(0);
    await runtime.openSession("a");
    await startWorker(runtime);

    const { promise: gate, resolve: releaseSnapshot } = deferredSignal();
    const { promise: started, resolve: snapshotStarted } = deferredSignal();
    const workerA = workers[0]!;
    const request = workerA.request.bind(workerA);
    workerA.request = async <T>(
      command: Record<string, unknown>,
    ): Promise<T> => {
      if (command.type === "get_state") {
        snapshotStarted();
        await gate;
      }
      return request<T>(command);
    };

    const snapshotting = runtime.snapshot("a");
    await started;
    await runtime.openSession("b");
    releaseSnapshot();

    const snapshot = await snapshotting;
    expect(snapshot.active?.sessionId).toBe("a");
    const globalOnly = await runtime.snapshot(null);
    expect(globalOnly.active).toBeNull();
    expect(Object.keys(globalOnly.sessionStatuses).sort()).toEqual(["a", "b"]);
    expect(runtime.startupSessionHint).toBe("b");
    await runtime.close();
  });

  it("publishes and restores needs-input status for an independently observed worker", async () => {
    const { runtime, workers } = schedulingRuntime({
      sessions: [record("a", "/project"), record("b", "/project")],
    });
    trackRuntime(runtime);
    await runtime.openSession("a");
    await startWorker(runtime);
    await runtime.openSession("b");
    const events: Array<Record<string, unknown>> = [];
    const workerStatuses: RuntimeWorkerStatus[] = [];
    runtime.on("event", (event) => events.push(event));
    runtime.on("worker_status", (rpc, status) => {
      if (rpc === workers[0]) workerStatuses.push(status);
    });
    workers[0]!.emit("event", {
      type: "extension_ui_request",
      id: "needs-answer",
      method: "confirm",
      title: "Proceed?",
    });
    expect(events.at(-1)?.sessionStatus).toMatchObject({
      needsInput: true,
      indicator: "attention",
    });
    const snapshot = await runtime.snapshot("a");
    expect(snapshot.sessionStatuses.a?.needsInput).toBe(true);
    expect(snapshot.pendingExtensionUiRequests?.[0]?.id).toBe("needs-answer");
    expect(workerStatuses.at(-1)).toEqual({
      sessionId: "a",
      runState: "idle",
      needsInput: true,
    });
    await runtime.extensionUiResponse({
      sessionId: "a",
      id: "needs-answer",
      confirmed: true,
    });
    expect(
      (await runtime.snapshot("a")).sessionStatuses.a?.needsInput,
    ).toBeUndefined();
    expect(workerStatuses.at(-1)).toEqual({
      sessionId: "a",
      runState: "idle",
      needsInput: false,
    });
    expect(runtime.startupSessionHint).toBe("b");
  });

  it("shares cold opens, keeps the newest startup hint, and starts only the addressed writer", async () => {
    const gate = deferredSignal();
    const load = vi.fn(async (session: ReturnType<typeof record>) => {
      if (session.id === "a") await gate.promise;
      return preview(session);
    });
    const { runtime, workers } = fakeRuntime({
      sessions: [record("a", "/project/one"), record("b", "/project/two")],
      openSessionProjection: load,
    });
    const release = runtime.retainSessionView("a");
    const first = runtime.openSession("a");
    const second = runtime.openSession("a");
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      await runtime.openSession("b");
      gate.resolve();
      const snapshots = await Promise.all([first, second]);
      expect(load.mock.calls.map(([session]) => session.id)).toEqual([
        "a",
        "b",
      ]);
      for (const { active } of snapshots) {
        expect(active).toMatchObject({
          sessionId: "a",
          transcriptPage: { messages: [{ content: "preview:a" }] },
        });
      }
      expect(workers).toHaveLength(0);
      expect(runtime.startupSessionHint).toBe("b");

      await runtime.prompt({
        sessionId: "a",
        expectedViewId: snapshots[0].active!.transcriptPage.viewId,
        message: "Continue in this view",
      });
      expect(workers.map(({ sessionId }) => sessionId)).toEqual(["a"]);
      expect(runtime.startupSessionHint).toBe("b");
    } finally {
      gate.resolve();
      await Promise.allSettled([first, second]);
      release();
      await runtime.close();
    }
  });

  it("publishes conflict status independently of the startup hint", async () => {
    const { runtime } = schedulingRuntime({
      sessions: [record("a", "/tmp"), record("b", "/tmp")],
    });
    type InternalSlot = {
      conflict: {
        kind: "external-change" | "projection-failure";
        message: string;
        revision: number;
      } | null;
      runState: string;
      attention: "completed" | "failed" | null;
    };
    const slots = (runtime as unknown as { slots: Map<string, InternalSlot> })
      .slots;
    trackRuntime(runtime);
    await runtime.openSession("a");
    const a = slots.get("a")!;
    a.conflict = {
      kind: "external-change",
      message: "external update",
      revision: 2,
    };
    a.runState = "conflict";
    a.attention = null;
    expect((await runtime.snapshot(null)).sessionStatuses.a).toEqual({
      runState: "conflict",
      indicator: "attention",
    });

    const selectedB = await runtime.openSession("b");
    expect(selectedB.sessionStatuses.a).toEqual({
      runState: "conflict",
      indicator: "attention",
    });

    a.conflict = {
      kind: "projection-failure",
      message: "damaged projection",
      revision: 3,
    };
    expect((await runtime.snapshot(null)).sessionStatuses.a).toEqual({
      runState: "conflict",
      indicator: "failed",
    });
  });

  it("publishes outcomes independently of which session another browser opens", async () => {
    const events: Array<Record<string, unknown>> = [];
    const { runtime, workers } = schedulingRuntime({
      sessions: [record("a", "/project"), record("b", "/project")],
    });
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );

    await runtime.openSession("a");
    await startWorker(runtime);
    await runtime.openSession("b");
    await startWorker(runtime, "b");
    workers[0]!.emit("event", { type: "agent_start" });
    expect((await runtime.snapshot(null)).sessionStatuses.a).toEqual({
      runState: "running",
      indicator: "running",
    });

    workers[0]!.emit("event", { type: "agent_settled" });
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(null)).sessionStatuses.a).toMatchObject({
        runState: "idle",
        indicator: "completed",
        attentionId: expect.any(Number),
      });
    });
    expect(
      events.findLast((event) => event.type === "agent_settled"),
    ).toMatchObject({
      type: "agent_settled",
      sessionId: "a",
      sessionStatus: { indicator: "completed" },
    });

    const completed = (await runtime.snapshot(null)).sessionStatuses.a;
    await runtime.openSession("a");
    expect((await runtime.snapshot(null)).sessionStatuses.a).toEqual(completed);

    workers[1]!.emit("event", { type: "agent_start" });
    workers[1]!.emit("event", {
      type: "message_end",
      message: { role: "assistant", stopReason: "error" },
    });
    workers[1]!.emit("event", { type: "agent_settled" });
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(null)).sessionStatuses.b).toMatchObject({
        runState: "failed",
        indicator: "failed",
        attentionId: expect.any(Number),
      });
    });

    const failed = (await runtime.snapshot(null)).sessionStatuses.b;
    await runtime.openSession("b");
    expect((await runtime.snapshot(null)).sessionStatuses.b).toEqual(failed);
    await runtime.close();
  });
});
