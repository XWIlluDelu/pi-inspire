import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PiRpcOutcomeUnknownError } from "../../server/pi-rpc.js";

import {
  MAX_EXTENSION_KEY_CHARS,
  MAX_EXTENSION_STATUS_CHARS,
  MAX_EXTENSION_STATUSES,
} from "../../shared/contracts.js";

import {
  disposeRuntimeFixture,
  initializeRuntimeFixture,
  record,
  schedulingRuntime,
  trackRuntime,
  waitForReady,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("extension displays and dialog ownership", () => {
  it("bounds untrusted widget/status data and keeps unknown methods inspectable or cancellable", async () => {
    const f = schedulingRuntime();
    const { runtime } = f;
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event: Record<string, unknown>) => events.push(event));
    trackRuntime(runtime);
    await runtime.openSession("a");
    await waitForReady(runtime);
    const emit = (method: string, fields: Record<string, unknown>) =>
      f.worker.emit("event", {
        type: "extension_ui_request",
        method,
        ...fields,
      });

    emit("setWidget", {
      id: "widget",
      widgetKey: "plan",
      widgetLines: ["one", "two"],
      widgetPlacement: "belowEditor",
      extensionPath: "/extensions/plan.ts",
      apiToken: "widget-secret",
    });
    const widget = (await runtime.snapshot()).extensionDisplays;
    expect(widget).toEqual([
      {
        id: "setWidget:plan",
        kind: "widget",
        label: "plan",
        source: "/extensions/plan.ts",
        placement: "belowEditor",
        lines: ["one", "two"],
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      responseRequired: false,
      extensionDisplays: widget,
    });
    expect(JSON.stringify(events.at(-1))).not.toContain("widget-secret");

    emit("setWidget", {
      id: "oversized-key",
      widgetKey: "k".repeat(MAX_EXTENSION_KEY_CHARS + 1),
      widgetLines: ["must be rejected"],
    });
    expect((await runtime.snapshot()).extensionDisplays).toEqual(widget);

    emit("setWidget", {
      id: "oversized-widget",
      widgetKey: "plan",
      widgetLines: ["x".repeat(140 * 1024)],
    });
    emit("showPanel", {
      id: "panel",
      responseRequired: false,
      extensionPath: "/extensions/build.ts",
      body: "x".repeat(140 * 1024),
      apiToken: "must not cross",
    });
    const raw = (await runtime.snapshot()).extensionDisplays;
    expect(raw).toMatchObject([
      { id: "setWidget:plan", kind: "raw", payload: { truncated: true } },
      {
        id: "showPanel:panel",
        kind: "raw",
        source: "/extensions/build.ts",
        method: "showPanel",
        payload: { truncated: true },
      },
    ]);
    expect(JSON.stringify(raw)).not.toContain("must not cross");

    emit("setStatus", {
      id: "unicode-status",
      statusKey: "usage",
      statusText: "🧭".repeat(MAX_EXTENSION_STATUS_CHARS + 1),
    });
    const bounded = `${"🧭".repeat(MAX_EXTENSION_STATUS_CHARS - 1)}…`;
    expect((await runtime.snapshot()).extensionStatuses).toEqual({
      usage: bounded,
    });
    expect(events.at(-1)).toMatchObject({
      extensionStatuses: { usage: bounded },
    });
    for (let index = 0; index <= MAX_EXTENSION_STATUSES; index++) {
      emit("setStatus", {
        id: `status-${index}`,
        statusKey: `status-${index}`,
        statusText: String(index),
      });
    }
    const statuses = (await runtime.snapshot()).extensionStatuses;
    expect(Object.keys(statuses ?? {})).toHaveLength(MAX_EXTENSION_STATUSES);
    expect(statuses).not.toHaveProperty("usage");
    expect(statuses).toHaveProperty(
      `status-${MAX_EXTENSION_STATUSES}`,
      String(MAX_EXTENSION_STATUSES),
    );

    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
    emit("chooseFiles", {
      id: "future-dialog",
      title: "Choose files",
      paths: ["a", "b"],
    });
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([
      expect.objectContaining({
        id: "future-dialog",
        method: "chooseFiles",
        unsupported: true,
      }),
    ]);
    await runtime.extensionUiResponse({
      sessionId: "a",
      id: "future-dialog",
      cancelled: true,
    });
    expect(f.worker.uiResponses).toEqual([
      { id: "future-dialog", cancelled: true },
    ]);
  });

  it("keeps queued questions with their worker during settlement, selection, Stop and exit", async () => {
    const { runtime, workers } = schedulingRuntime({
      sessions: [record("a", "/project"), record("b", "/project")],
    });
    trackRuntime(runtime);
    await runtime.openSession("a");
    await waitForReady(runtime, "a");
    await runtime.openSession("b");
    await waitForReady(runtime, "b");
    const worker = workers[0]!;
    const other = workers[1]!;
    const question = (id: string) =>
      worker.emit("event", {
        type: "extension_ui_request",
        id,
        method: "confirm",
      });
    question("first");
    question("second");
    worker.emit("event", { type: "agent_settled" });
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
    const restored = await runtime.openSession("a");
    expect(restored.pendingExtensionUiRequests?.map(({ id }) => id)).toEqual([
      "first",
      "second",
    ]);

    const send = worker.sendExtensionUiResponse.bind(worker);
    worker.sendExtensionUiResponse = (response) => {
      send(response);
      if (response.id === "first") question("during-stop");
    };
    await runtime.abort("a");
    expect(worker.uiResponses).toEqual([
      { id: "first", cancelled: true },
      { id: "second", cancelled: true },
    ]);
    expect(other.uiResponses).toEqual([]);
    expect(
      (await runtime.snapshot()).pendingExtensionUiRequests?.map(
        ({ id }) => id,
      ),
    ).toEqual(["during-stop"]);
    worker.emit("exit", new Error("worker lost"));
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
  });

  it.each(["timeout", "exit"] as const)(
    "reports uncertain extension delivery after a read-only fence %s without inferring worker liveness",
    async (failure) => {
      const f = schedulingRuntime({
        configure(worker) {
          let failFence = true;
          const request = worker.request.bind(worker);
          worker.request = async <T>(command: Record<string, unknown>) => {
            if (
              failFence &&
              command.type === "get_state" &&
              worker.uiResponses.length > 0
            ) {
              failFence = false;
              const error = new Error("Read-only fence failed");
              if (failure === "exit") worker.emit("exit", error);
              throw error;
            }
            return request<T>(command);
          };
        },
      });
      const { runtime } = f;
      trackRuntime(runtime);
      await runtime.openSession("a");
      await waitForReady(runtime);
      const { worker } = f;
      worker.emit("event", {
        type: "extension_ui_request",
        id: "unknown-ui",
        method: "confirm",
      });
      await expect(
        runtime.extensionUiResponse({
          sessionId: "a",
          id: "unknown-ui",
          confirmed: true,
        }),
      ).rejects.toMatchObject({
        status: 504,
        code: "PI_RPC_OUTCOME_UNKNOWN",
        outcomeUnknown: true,
      });
      const snapshot = await runtime.snapshot();
      expect(snapshot.runState).toBe(failure === "exit" ? "failed" : "idle");
      expect(snapshot.pendingExtensionUiRequests).toEqual([]);
      await expect(
        runtime.extensionUiResponse({
          sessionId: "a",
          id: "unknown-ui",
          confirmed: true,
        }),
      ).rejects.toThrow();
      expect(worker.uiResponses).toEqual([
        { id: "unknown-ui", confirmed: true },
      ]);
    },
  );

  it("retires the writer when extension-response stdin delivery is acceptance-unknown", async () => {
    const f = schedulingRuntime({
      configure: (worker) => {
        worker.sendExtensionUiResponse = async () => {
          const error = new PiRpcOutcomeUnknownError("extension_ui_response");
          error.stopped = Promise.resolve();
          throw error;
        };
      },
    });
    const { runtime } = f;
    trackRuntime(runtime);
    await runtime.openSession("a");
    await waitForReady(runtime);
    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "unknown-write",
      method: "confirm",
    });
    await expect(
      runtime.extensionUiResponse({
        sessionId: "a",
        id: "unknown-write",
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "PI_RPC_OUTCOME_UNKNOWN" });
    expect(f.worker.stops).toBe(1);
    expect((await runtime.snapshot()).runState).toBe("conflict");
  });
});
