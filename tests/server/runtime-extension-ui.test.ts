import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PiRpcOutcomeUnknownError,
  type PiRpcProcess,
} from "../../server/pi-rpc.js";

import { RuntimeController } from "../../server/runtime.js";

import {
  MAX_EXTENSION_KEY_CHARS,
  MAX_EXTENSION_STATUS_CHARS,
} from "../../shared/contracts.js";

import {
  FakeRpc,
  record,
  preview,
  catalog,
  trackedAttachmentStore,
  schedulingRuntime,
  initializeRuntimeFixture,
  disposeRuntimeFixture,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("extension displays and dialog ownership", () => {
  it("projects text widgets, bounds raw displays, and cancels unknown interactive methods", async () => {
    const store = trackedAttachmentStore();
    const f = schedulingRuntime({ attachments: store });
    const { runtime } = f;
    const emitted: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) =>
      emitted.push(event as Record<string, unknown>),
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));

    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "widget-1",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["one", "two"],
      widgetPlacement: "belowEditor",
      extensionPath: "/extensions/plan.ts",
      body: "must not cross from a native widget",
      apiToken: "must not cross",
    });
    let snapshot = await runtime.snapshot();
    expect(snapshot.extensionDisplays).toEqual([
      {
        id: "setWidget:plan",
        kind: "widget",
        label: "plan",
        source: "/extensions/plan.ts",
        placement: "belowEditor",
        lines: ["one", "two"],
      },
    ]);
    expect(JSON.stringify(snapshot.extensionDisplays)).not.toContain(
      "must not cross",
    );
    expect(snapshot.pendingExtensionUiRequests).toEqual([]);
    const widgetEvent = emitted.findLast(
      (event) =>
        event.type === "extension_ui_request" && event.id === "widget-1",
    );
    expect(widgetEvent).toEqual(
      expect.objectContaining({
        method: "setWidget",
        responseRequired: false,
        extensionDisplays: snapshot.extensionDisplays,
      }),
    );
    expect(widgetEvent).not.toHaveProperty("body");
    expect(widgetEvent).not.toHaveProperty("apiToken");

    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "widget-key-oversized",
      method: "setWidget",
      widgetKey: "k".repeat(MAX_EXTENSION_KEY_CHARS + 1),
      widgetLines: ["must be rejected"],
    });
    snapshot = await runtime.snapshot();
    expect(snapshot.extensionDisplays).toEqual([
      expect.objectContaining({ id: "setWidget:plan", kind: "widget" }),
    ]);
    expect(emitted.at(-1)).toMatchObject({
      extensionDisplays: snapshot.extensionDisplays,
    });
    expect(emitted.at(-1)).not.toHaveProperty("widgetKey");
    expect(emitted.at(-1)).not.toHaveProperty("widgetLines");

    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "widget-oversized",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["x".repeat(140 * 1024)],
    });
    snapshot = await runtime.snapshot();
    expect(snapshot.extensionDisplays).toEqual([
      expect.objectContaining({
        id: "setWidget:plan",
        kind: "raw",
        payload: expect.objectContaining({ truncated: true }),
      }),
    ]);

    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      statusKey: "usage",
      statusText: "37%",
      responseRequired: false,
    });
    snapshot = await runtime.snapshot();
    expect(snapshot.extensionDisplays).toHaveLength(1);
    expect(snapshot.extensionStatuses).toEqual({ usage: "37%" });
    expect(emitted.at(-1)).toMatchObject({
      type: "extension_ui_request",
      method: "setStatus",
      extensionStatuses: { usage: "37%" },
    });
    expect(emitted.at(-1)).not.toHaveProperty("extensionDisplays");
    expect(emitted.at(-1)).not.toHaveProperty("statusText");

    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "status-oversized",
      method: "setStatus",
      statusKey: "usage",
      statusText: "x".repeat(MAX_EXTENSION_STATUS_CHARS + 200),
    });
    expect((await runtime.snapshot()).extensionStatuses?.usage).toBe(
      `${"x".repeat(MAX_EXTENSION_STATUS_CHARS - 1)}…`,
    );

    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "status-multibyte",
      method: "setStatus",
      statusKey: "usage",
      statusText: "🧭".repeat(MAX_EXTENSION_STATUS_CHARS + 1),
    });
    const multibyteStatus = (await runtime.snapshot()).extensionStatuses?.usage;
    expect(multibyteStatus).toBeDefined();
    expect(Array.from(multibyteStatus!).length).toBeLessThanOrEqual(
      MAX_EXTENSION_STATUS_CHARS,
    );
    expect(multibyteStatus).toMatch(/^(?:🧭)*…$/u);

    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "status-clear",
      method: "setStatus",
      statusKey: "usage",
    });
    expect((await runtime.snapshot()).extensionStatuses).toEqual({});

    for (let index = 0; index < 22; index += 1) {
      f.worker.emit("event", {
        type: "extension_ui_request",
        id: `status-${index}`,
        method: "setStatus",
        statusKey: `status-${index}`,
        statusText: String(index),
      });
    }
    snapshot = await runtime.snapshot();
    expect(Object.keys(snapshot.extensionStatuses ?? {})).toHaveLength(20);
    expect(snapshot.extensionStatuses).not.toHaveProperty("status-0");
    expect(snapshot.extensionStatuses).not.toHaveProperty("status-1");
    expect(snapshot.extensionStatuses).toMatchObject({ "status-21": "21" });

    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "panel-1",
      method: "showPanel",
      responseRequired: false,
      extensionPath: "/extensions/build.ts",
      body: "x".repeat(140 * 1024),
      apiToken: "must not cross",
    });
    snapshot = await runtime.snapshot();
    expect(snapshot.extensionDisplays?.at(-1)).toEqual(
      expect.objectContaining({
        id: "showPanel:panel-1",
        kind: "raw",
        label: "panel-1",
        source: "/extensions/build.ts",
        method: "showPanel",
        payload: expect.objectContaining({ truncated: true }),
      }),
    );
    expect(JSON.stringify(snapshot.extensionDisplays)).not.toContain(
      "must not cross",
    );

    f.worker.emit("event", {
      type: "extension_ui_request",
      id: "future-dialog",
      method: "chooseFiles",
      title: "Choose files",
      paths: ["a", "b"],
    });
    snapshot = await runtime.snapshot();
    expect(snapshot.pendingExtensionUiRequests).toEqual([
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
    expect(f.worker.uiResponses).toContainEqual({
      id: "future-dialog",
      cancelled: true,
    });
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
    await runtime.close();
  });

  it("preserves dialogs across model settlement and clears them on expiry, response, Stop, or worker loss", async () => {
    const store = trackedAttachmentStore();
    let worker!: FakeRpc;
    const emitted: Array<Record<string, unknown>> = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    runtime.on("event", (event) =>
      emitted.push(event as Record<string, unknown>),
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));

    worker.emit("event", {
      type: "extension_ui_request",
      id: "first",
      method: "confirm",
      timeout: 100,
    });
    worker.emit("event", {
      type: "extension_ui_request",
      id: "second",
      method: "input",
    });
    let snapshot = await runtime.snapshot();
    expect(
      snapshot.pendingExtensionUiRequests?.map((request) => request.id),
    ).toEqual(["first", "second"]);
    expect(snapshot.pendingExtensionUiRequests?.[0]?.timeout).toBe(100);
    expect(snapshot.pendingExtensionUiRequests?.[0]?.expiresAt).toBeGreaterThan(
      Date.now(),
    );

    await new Promise((resolveTimer) => setTimeout(resolveTimer, 120));
    snapshot = await runtime.snapshot();
    expect(
      snapshot.pendingExtensionUiRequests?.map((request) => request.id),
    ).toEqual(["second"]);
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "extension_ui_remove",
        id: "first",
        reason: "expired",
      }),
    );
    await expect(
      runtime.extensionUiResponse({
        sessionId: "a",
        id: "first",
        confirmed: true,
      }),
    ).rejects.toThrow(/no longer pending/);
    expect(worker.uiResponses).not.toContainEqual(
      expect.objectContaining({ id: "first" }),
    );

    await runtime.extensionUiResponse({
      sessionId: "a",
      id: "second",
      value: "answer",
    });
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
    worker.emit("event", {
      type: "extension_ui_request",
      id: "abort-a",
      method: "confirm",
      timeout: 1_000,
    });
    worker.emit("event", {
      type: "extension_ui_request",
      id: "abort-b",
      method: "confirm",
    });
    const send = worker.sendExtensionUiResponse.bind(worker);
    worker.sendExtensionUiResponse = (response) => {
      send(response);
      if (response.id === "abort-a")
        worker.emit("event", {
          type: "extension_ui_request",
          id: "new-during-cancel",
          method: "input",
        });
    };
    await runtime.abort("a");
    expect(worker.uiResponses).toEqual(
      expect.arrayContaining([
        { id: "abort-a", cancelled: true },
        { id: "abort-b", cancelled: true },
      ]),
    );
    expect(
      (await runtime.snapshot()).pendingExtensionUiRequests?.map((r) => r.id),
    ).toEqual(["new-during-cancel"]);
    await runtime.extensionUiResponse({
      sessionId: "a",
      id: "new-during-cancel",
      cancelled: true,
    });

    worker.emit("event", {
      type: "extension_ui_request",
      id: "settle-a",
      method: "confirm",
    });
    worker.emit("event", {
      type: "extension_ui_request",
      id: "settle-b",
      method: "confirm",
    });
    worker.emit("event", { type: "agent_settled" });
    expect(
      (await runtime.snapshot()).pendingExtensionUiRequests?.map(
        (request) => request.id,
      ),
    ).toEqual(["settle-a", "settle-b"]);
    await runtime.extensionUiResponse({
      sessionId: "a",
      id: "settle-a",
      confirmed: true,
    });
    expect(worker.uiResponses).toContainEqual({
      id: "settle-a",
      confirmed: true,
    });
    expect(
      (await runtime.snapshot()).pendingExtensionUiRequests?.map(
        (request) => request.id,
      ),
    ).toEqual(["settle-b"]);

    worker.emit("event", {
      type: "extension_ui_request",
      id: "replacement",
      method: "confirm",
      timeout: 1_000,
    });
    worker.emit("exit", new Error("replace worker"));
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
    await runtime.close();
  });

  it("treats a written extension response with a lost ordered fence as acceptance-unknown", async () => {
    const store = trackedAttachmentStore();
    let worker!: FakeRpc;
    let responseWritten = false;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        const send = worker.sendExtensionUiResponse.bind(worker);
        worker.sendExtensionUiResponse = (response) => {
          send(response);
          responseWritten = true;
        };
        const request = worker.request.bind(worker);
        worker.request = async <T>(command: Record<string, unknown>) => {
          if (responseWritten && command.type === "get_state") {
            const error = new PiRpcOutcomeUnknownError("get_state");
            error.stopped = Promise.resolve();
            throw error;
          }
          return request<T>(command);
        };
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
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
    ).rejects.toThrow(/outcome is unknown/);
    expect(worker.uiResponses).toEqual([{ id: "unknown-ui", confirmed: true }]);
    expect(worker.stops).toBe(1);
    expect((await runtime.snapshot()).runState).toBe("conflict");
    await expect(
      runtime.extensionUiResponse({
        sessionId: "a",
        id: "unknown-ui",
        confirmed: true,
      }),
    ).rejects.toThrow();
    expect(worker.uiResponses).toHaveLength(1);
    await runtime.close();
  });

  it("retires the writer when extension-response stdin delivery is acceptance-unknown", async () => {
    const store = trackedAttachmentStore();
    const f = schedulingRuntime({
      attachments: store,
      configure: (worker) => {
        worker.sendExtensionUiResponse = async () => {
          const error = new PiRpcOutcomeUnknownError("extension_ui_response");
          error.stopped = Promise.resolve();
          throw error;
        };
      },
    });
    const { runtime } = f;
    await runtime.openSession("a");
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
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
    ).rejects.toThrow(/outcome is unknown/);
    expect(f.worker.stops).toBe(1);
    expect((await runtime.snapshot()).runState).toBe("conflict");
    await runtime.close();
  });

  it("restores a background extension dialog when its session is viewed", async () => {
    const store = trackedAttachmentStore();
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/project"), record("b", "/project")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );

    await runtime.openSession("a");
    await runtime.openSession("b");
    const slots = (
      runtime as unknown as { slots: Map<string, { ready: boolean }> }
    ).slots;
    await vi.waitFor(() => expect(slots.get("a")?.ready).toBe(true));
    await vi.waitFor(() => expect(slots.get("b")?.ready).toBe(true));
    workers[0]!.emit("event", {
      type: "extension_ui_request",
      id: "question-1",
      method: "confirm",
      title: "Proceed?",
      message: "Confirm the operation",
    });
    expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);

    const restored = await runtime.openSession("a");
    expect(restored.pendingExtensionUiRequests).toEqual([
      {
        sessionId: "a",
        id: "question-1",
        method: "confirm",
        title: "Proceed?",
        message: "Confirm the operation",
      },
    ]);
    await runtime.openSession("b");
    await runtime.extensionUiResponse({
      sessionId: "a",
      id: "question-1",
      value: true,
    });
    expect(workers[0]!.uiResponses).toEqual([
      { id: "question-1", value: true },
    ]);
    expect(workers[1]!.uiResponses).toEqual([]);
    expect((await runtime.openSession("a")).pendingExtensionUiRequests).toEqual(
      [],
    );
    await runtime.close();
  });
});
