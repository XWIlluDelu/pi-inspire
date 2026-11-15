import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  it("publishes extension state after a browser joins a saved conversation", async () => {
    const { runtime, workers } = schedulingRuntime({
      configure(worker) {
        worker.startupEvent = {
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "test:service-tier",
          statusText: '{"tier":"standard"}',
        };
      },
    });
    trackRuntime(runtime);
    const ready = vi.fn();
    runtime.on("event", ready);
    const release = runtime.retainSessionView("a");
    try {
      const first = await runtime.snapshot("a");
      expect(first.active?.sessionId).toBe("a");
      expect(workers).toHaveLength(0);

      runtime.warmSessionView("a");
      runtime.warmSessionView("a");
      await vi.waitFor(() =>
        expect(ready).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "runtime_ready",
            sessionId: "a",
            extensionStatuses: { "test:service-tier": '{"tier":"standard"}' },
          }),
        ),
      );
      expect(workers).toHaveLength(1);
    } finally {
      release();
    }
  });

  it("routes writes to their addressed worker while another session is selected", async () => {
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
    } finally {
      gate.resolve();
      await Promise.allSettled([first, second]);
      release();
      await runtime.close();
    }
  });
});
