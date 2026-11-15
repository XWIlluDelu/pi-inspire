import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PiRpcOutcomeUnknownError } from "../../server/pi-rpc.js";
import {
  MAX_EXTENSION_KEY_CHARS,
  MAX_EXTENSION_STATUS_CHARS,
  MAX_EXTENSION_STATUSES,
} from "../../shared/contracts.js";
import {
  disposeIsolatedRuntimeFixture,
  fakeRuntime,
  initializeIsolatedRuntimeFixture,
  persistedRecord,
  startWorker,
  trackRuntime,
} from "./fixtures/runtime.js";

beforeEach(initializeIsolatedRuntimeFixture);
afterEach(disposeIsolatedRuntimeFixture);

async function fixture() {
  const f = fakeRuntime({
    sessions: [await persistedRecord("a")],
  });
  const { runtime } = f;
  trackRuntime(runtime);
  await runtime.openSession("a");
  await startWorker(runtime);
  const worker = f.workers[0]!;
  const emit = (method: string, fields: Record<string, unknown>) =>
    worker.emit("event", { type: "extension_ui_request", method, ...fields });
  const snapshot = () => runtime.snapshot("a");
  const answer = (id: string, cancelled = false) =>
    runtime.extensionUiResponse({
      sessionId: "a",
      id,
      ...(cancelled ? { cancelled: true } : { confirmed: true }),
    });
  return { ...f, worker, emit, snapshot, answer };
}

it("only publishes bounded extension display fields and allows cancellation of an unfamiliar request", async () => {
  const { runtime, worker, emit, snapshot, answer } = await fixture();
  const events: Record<string, unknown>[] = [];
  runtime.on("event", (event) => events.push(event));
  emit("setWidget", {
    id: "widget",
    widgetKey: "plan",
    widgetLines: ["one", "two"],
    widgetPlacement: "belowEditor",
    extensionPath: "/extensions/plan.ts",
    apiToken: "widget-secret",
  });
  const widget = [
    {
      id: "setWidget:plan",
      kind: "widget",
      label: "plan",
      source: "/extensions/plan.ts",
      placement: "belowEditor",
      lines: ["one", "two"],
    },
  ];
  expect(events.at(-1)).toMatchObject({
    responseRequired: false,
    extensionDisplays: widget,
  });
  expect(JSON.stringify(events.at(-1))).not.toContain("widget-secret");
  emit("setWidget", {
    id: "invalid-key",
    widgetKey: "x".repeat(MAX_EXTENSION_KEY_CHARS + 1),
    widgetLines: ["oversized"],
  });
  expect((await snapshot()).extensionDisplays).toEqual(widget);
  const large = "x".repeat(140 * 1024);
  emit("setWidget", { widgetKey: "plan", widgetLines: [large] });
  emit("showPanel", {
    id: "panel",
    responseRequired: false,
    body: large,
    apiToken: "must not cross",
  });
  expect((await snapshot()).extensionDisplays).toMatchObject([
    { id: "setWidget:plan", kind: "raw", payload: { truncated: true } },
    { id: "showPanel:panel", kind: "raw", payload: { truncated: true } },
  ]);
  expect(JSON.stringify(events)).not.toContain("must not cross");

  emit("setStatus", {
    statusKey: "unicode",
    statusText: "🧭".repeat(MAX_EXTENSION_STATUS_CHARS + 1),
  });
  expect(events.at(-1)).toMatchObject({
    extensionStatuses: {
      unicode: `${"🧭".repeat(MAX_EXTENSION_STATUS_CHARS - 1)}…`,
    },
  });
  for (let index = 0; index < MAX_EXTENSION_STATUSES; index++)
    emit("setStatus", {
      statusKey: `status-${index}`,
      statusText: String(index),
    });
  const statuses = (await snapshot()).extensionStatuses!;
  expect(Object.keys(statuses)).toHaveLength(MAX_EXTENSION_STATUSES);
  expect(statuses).not.toHaveProperty("unicode");
  emit("chooseFiles", { id: "future", paths: ["a", "b"], timeout: 30_000 });
  const pending = (await snapshot()).pendingExtensionUiRequests;
  expect(pending).toMatchObject([
    { id: "future", method: "chooseFiles", unsupported: true },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "extension_ui_pending",
    request: pending?.[0],
  });
  await answer("future", true);
  expect(worker.uiResponses).toEqual([{ id: "future", cancelled: true }]);
});

it.each(["timeout", "exit", "write"] as const)(
  "does not replay an uncertain extension answer after %s",
  async (fault) => {
    const { worker, emit, snapshot, answer } = await fixture();
    if (fault === "write") {
      vi.spyOn(worker, "sendExtensionUiResponse").mockImplementation(
        async () => {
          const error = new PiRpcOutcomeUnknownError("extension_ui_response");
          error.stopped = Promise.resolve();
          throw error;
        },
      );
    } else {
      worker.responseOverrides.set("get_state", () => {
        worker.responseOverrides.delete("get_state");
        const error = new Error("Read-only confirmation failed");
        if (fault === "exit") worker.emit("exit", error);
        throw error;
      });
    }
    emit("confirm", { id: "uncertain" });
    await expect(answer("uncertain")).rejects.toMatchObject({
      status: 504,
      code: "PI_RPC_OUTCOME_UNKNOWN",
      outcomeUnknown: true,
    });
    const state = await snapshot();
    expect(state.sessionStatuses.a?.runState).toBe(
      fault === "timeout" ? "idle" : fault === "exit" ? "failed" : "conflict",
    );
    expect(state.pendingExtensionUiRequests).toEqual([]);
    await expect(answer("uncertain")).rejects.toThrow();
    if (fault === "write") {
      expect(worker.stops).toBe(1);
      expect(worker.sendExtensionUiResponse).toHaveBeenCalledOnce();
    } else
      expect(worker.uiResponses).toEqual([
        { id: "uncertain", confirmed: true },
      ]);
  },
);
