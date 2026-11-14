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
  it("keeps independent workers, dialogs, and outcomes while another session is selected", async () => {
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
      runState: "queued",
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
      runState: "queued",
      needsInput: false,
    });
    expect(runtime.startupSessionHint).toBe("b");
    const status = async (id: string) =>
      (await runtime.snapshot(null)).sessionStatuses[id];
    for (const [index, id, outcome] of [
      [0, "a", "completed"],
      [1, "b", "failed"],
    ] as const) {
      const worker = workers[index]!;
      worker.emit("event", { type: "agent_start" });
      expect(await status(id)).toMatchObject({
        runState: "running",
        indicator: "running",
      });
      if (outcome === "failed")
        worker.emit("event", {
          type: "message_end",
          message: { role: "assistant", stopReason: "error" },
        });
      worker.emit("event", { type: "agent_settled" });
      const settled = await vi.waitFor(async () => {
        const current = await status(id);
        expect(current).toMatchObject({
          runState: outcome === "failed" ? "failed" : "idle",
          indicator: outcome,
          attentionId: expect.any(Number),
        });
        return current;
      });
      expect(
        events.findLast(({ type }) => type === "agent_settled"),
      ).toMatchObject({
        sessionId: id,
        sessionStatus: { indicator: outcome },
      });
      await runtime.openSession(id);
      expect(await status(id)).toEqual(settled);
    }
    expect(workers.map(({ stops }) => stops)).toEqual([0, 0]);
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

      const worker = workers[0]!;
      const read = deferredSignal();
      const waiting = deferredSignal();
      const failure = new Error("snapshot failed before selection");
      let refuseRead = false;
      worker.responseOverrides.set("get_state", async () => {
        waiting.resolve();
        await read.promise;
        if (refuseRead) throw failure;
        return { sessionId: "a", sessionFile: worker.sessionPath };
      });
      const snapshotting = runtime.snapshot("a");
      try {
        await waiting.promise;
        await runtime.openSession("b");
        read.resolve();
        expect((await snapshotting).active?.sessionId).toBe("a");
        expect(await runtime.snapshot(null)).toMatchObject({ active: null });
        refuseRead = true;
        await expect(runtime.openSession("a")).rejects.toBe(failure);
        expect(runtime.startupSessionHint).toBe("b");
      } finally {
        read.resolve();
        await snapshotting.catch(() => {});
      }
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
});
