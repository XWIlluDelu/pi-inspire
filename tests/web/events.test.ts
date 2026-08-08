import { describe, expect, it } from "vitest";
import { emptyEventSlice, reduceEvent, type EventSlice, type WireEvent } from "../../src/events";

function reduce(slice: EventSlice, settled: ReadonlySet<string>, event: WireEvent) {
  return reduceEvent(slice, settled, event);
}

describe("message reconciliation", () => {
  it("ignores a message_start whose key is already settled (post-resync duplicate)", () => {
    const slice = emptyEventSlice();
    slice.messages = [{ role: "user", content: "hi", timestamp: 1 }];
    const settled = new Set(["user:1"]);
    const { slice: next, changed } = reduce(slice, settled, {
      type: "message_start",
      message: { role: "user", content: "hi", timestamp: 1 },
    });
    expect(changed).toBe(false);
    expect(next).toBe(slice); // same reference: nothing to publish
    expect(next.messages).toHaveLength(1);
    expect(next.messages).toBe(slice.messages); // untouched
  });

  it("replaces the trailing unsettled assistant message on update", () => {
    const slice = emptyEventSlice();
    const start = reduce(slice, new Set(), {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 2 },
    });
    const update = reduce(start.slice, new Set(), {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "ab" }], timestamp: 2 },
    });
    expect(update.slice.messages).toHaveLength(1);
    expect(update.slice.messages[0]!.content).toEqual([{ type: "text", text: "ab" }]);
    expect(start.slice.streaming).toBe(true);
    expect(start.slice.activeAssistantMessageKey).toBe("assistant:2");
    expect(start.slice.runState).toBe("running");
  });

  it("reconstructs Pi 0.84 message_update deltas without creating phantom rows", () => {
    let result = reduce(emptyEventSlice(), new Set(), {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        timestamp: 2,
        provider: "openai-codex",
        model: "gpt-5.6",
        __inspireLiveId: "call-1",
      },
    });

    const updates: WireEvent[] = [
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "check " } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "state" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "check state" } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "hel" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "tool-1", toolName: "read" },
      },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "{\"path\":" } },
    ];
    for (const update of updates) result = reduce(result.slice, new Set(), update);

    expect(result.slice.messages[0]!.content).toMatchObject([
      { type: "thinking", thinking: "check state" },
      { type: "text", text: "hello" },
      { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
    ]);

    result = reduce(result.slice, new Set(), {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
      },
    });
    expect(result.slice.messages).toHaveLength(1);
    expect(result.slice.messages[0]).toMatchObject({
      role: "assistant",
      __inspireLiveId: "call-1",
      content: [
        { type: "thinking", thinking: "check state" },
        { type: "text", text: "hello" },
        { type: "toolCall", id: "tool-1", name: "read" },
      ],
    });
  });

  it("resyncs rather than applying a delta when no assistant call is active", () => {
    const slice = emptyEventSlice();
    slice.messages = [{ role: "assistant", content: [{ type: "text", text: "settled" }], timestamp: 1 }];
    const result = reduce(slice, new Set(["assistant:1"]), {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "orphan" },
    });
    expect(result.resync).toBe(true);
    expect(result.slice.messages).toBe(slice.messages);
    expect(result.slice.messages[0]!.content).toEqual([{ type: "text", text: "settled" }]);
  });

  it("settles message keys on message_end so later duplicates are dropped", () => {
    const slice = emptyEventSlice();
    const end = reduce(slice, new Set(), {
      type: "message_end",
      message: { role: "assistant", content: [], timestamp: 3 },
    });
    expect(end.settle).toEqual(["assistant:3"]);
    expect(end.slice.streaming).toBe(false);

    const settled = new Set(end.settle);
    const duplicate = reduce(end.slice, settled, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: 3 },
    });
    expect(duplicate.slice.messages).toHaveLength(1);
    expect(duplicate.changed).toBe(false);
  });

  it("keeps the current assistant key through its tool batch and replaces it at the next LLM call", () => {
    const firstStart = reduce(emptyEventSlice(), new Set(), {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: 2, __inspireLiveId: "call-1" },
    });
    const firstEnd = reduce(firstStart.slice, new Set(), {
      type: "message_end",
      message: { role: "assistant", content: [], timestamp: 2, __inspireLiveId: "call-1" },
    });
    expect(firstEnd.slice.activeAssistantMessageKey).toBe("live:call-1");

    const secondStart = reduce(firstEnd.slice, new Set(firstEnd.settle), {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: 3, __inspireLiveId: "call-2" },
    });
    expect(secondStart.slice.activeAssistantMessageKey).toBe("live:call-2");
  });

  it("keeps same-role same-timestamp ordinary lifecycles distinct by host live identity", () => {
    let slice = emptyEventSlice();
    const settled = new Set<string>();
    for (const [id, content] of [["live-1", "first"], ["live-2", "second"]] as const) {
      const start = reduce(slice, settled, {
        type: "message_start",
        message: { role: "assistant", content, timestamp: 2, __inspireLiveId: id },
      });
      const end = reduce(start.slice, settled, {
        type: "message_end",
        message: { role: "assistant", content, timestamp: 2, __inspireLiveId: id },
      });
      for (const key of end.settle) settled.add(key);
      slice = end.slice;
    }
    expect(slice.messages.map((message) => message.content)).toEqual(["first", "second"]);
    expect(settled).toEqual(new Set(["live:live-1", "live:live-2"]));
  });

  it("appends genuinely new messages in source order", () => {
    const slice = emptyEventSlice();
    const first = reduce(slice, new Set(), { type: "message_start", message: { role: "user", content: "a", timestamp: 1 } });
    const second = reduce(first.slice, new Set(), {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: 2 },
    });
    expect(second.slice.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("does not overwrite an older keyed turn when its end event is absent", () => {
    const slice = emptyEventSlice();
    slice.messages = [
      { role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 2 },
      { role: "user", content: "second question", timestamp: 3 },
    ];

    const next = reduce(slice, new Set(), {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "second answer" }], timestamp: 4 },
    });

    expect(next.slice.messages.map((message) => message.timestamp)).toEqual([2, 3, 4]);
    expect(next.slice.messages[0]!.content).toEqual([{ type: "text", text: "first answer" }]);
  });

  it("requests an authoritative resync on settle and clears transient activity", () => {
    const slice = emptyEventSlice();
    slice.activeAssistantMessageKey = "live:active-assistant";
    slice.tools = { t1: { id: "t1", name: "bash", phase: "running" } };
    slice.retry = { attempt: 1, maxAttempts: 3, message: "x" };
    slice.queue = { steering: ["steer"], followUp: ["later one", "later two"] };
    const { slice: next, resync } = reduce(slice, new Set(), { type: "agent_settled" });
    expect(resync).toBe(true);
    expect(next.streaming).toBe(false);
    expect(next.activeAssistantMessageKey).toBeNull();
    expect(next.tools).toEqual({});
    expect(next.retry).toBeNull();
    expect(next.queue).toEqual({ steering: [], followUp: [] });
  });
});

describe("transient tool/retry/queue activity", () => {
  it("maps tool_execution start/update/end into per-tool activity", () => {
    const slice = emptyEventSlice();
    const started = reduce(slice, new Set(), {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "read",
      args: { path: "src/index.ts" },
    });
    expect(started.slice.tools.t1).toMatchObject({ name: "read", phase: "running", detail: "src/index.ts" });

    const updated = reduce(started.slice, new Set(), {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "read",
      args: {},
      partialResult: { content: [{ type: "text", text: "reading lines 1-40" }] },
    });
    expect(updated.slice.tools.t1).toMatchObject({ phase: "running", detail: "reading lines 1-40" });

    const failed = reduce(updated.slice, new Set(), {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "read",
      result: {},
      isError: true,
    });
    expect(failed.slice.tools.t1!.phase).toBe("error");
    // truthful: the last known detail survives completion
    expect(failed.slice.tools.t1!.detail).toBe("reading lines 1-40");
  });

  it("maps auto-retry start/end into run state and retry info", () => {
    const slice = emptyEventSlice();
    const started = reduce(slice, new Set(), {
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 5,
      errorMessage: "rate limited",
    });
    expect(started.slice.runState).toBe("retrying");
    expect(started.slice.retry).toEqual({ attempt: 2, maxAttempts: 5, message: "rate limited" });

    const recovered = reduce(started.slice, new Set(), { type: "auto_retry_end", success: true, attempt: 2 });
    expect(recovered.slice.runState).toBe("running");
    expect(recovered.slice.retry).toBeNull();

    const failed = reduce(started.slice, new Set(), {
      type: "auto_retry_end",
      success: false,
      attempt: 5,
      finalError: "overloaded",
    });
    expect(failed.slice.runState).toBe("failed");
    expect(failed.slice.notices.at(-1)).toMatchObject({ kind: "error", text: "Retry failed: overloaded" });
  });

  it("preserves queued steering and follow-up input in separate source order", () => {
    const { slice } = reduce(emptyEventSlice(), new Set(), {
      type: "queue_update",
      steering: ["a"],
      followUp: ["b", "c"],
    });
    expect(slice.queue).toEqual({ steering: ["a"], followUp: ["b", "c"] });
  });

  it("surfaces extension errors as error notices without touching messages", () => {
    const { slice } = reduce(emptyEventSlice(), new Set(), {
      type: "extension_error",
      extensionPath: "ext/weather.ts",
      event: "tool_call",
      error: "boom",
    });
    expect(slice.notices.at(-1)).toMatchObject({ kind: "error" });
    expect(slice.notices.at(-1)!.text).toContain("ext/weather.ts");
    expect(slice.notices.at(-1)!.text).toContain("boom");
    expect(slice.messages).toHaveLength(0);
  });
});

describe("extension_ui_request mapping", () => {
  it("presents dialog methods as a pending request", () => {
    const { slice } = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request",
      sessionId: "s1",
      id: "r1",
      method: "select",
      title: "Pick one",
      options: ["a", "b"],
    });
    expect(slice.extensionUiRequests).toEqual([{
      sessionId: "s1",
      id: "r1",
      method: "select",
      title: "Pick one",
      message: undefined,
      options: ["a", "b"],
      placeholder: undefined,
      prefill: undefined,
    }]);
  });

  it("queues concurrent dialogs in arrival order and removes only the addressed request", () => {
    let slice = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request", sessionId: "s1", id: "first", method: "confirm", timeout: 1_000, expiresAt: 2_000,
    }).slice;
    slice = reduce(slice, new Set(), {
      type: "extension_ui_request", sessionId: "s1", id: "second", method: "input",
    }).slice;
    expect(slice.extensionUiRequests.map((request) => request.id)).toEqual(["first", "second"]);
    expect(slice.extensionUiRequests[0]).toMatchObject({ timeout: 1_000, expiresAt: 2_000 });

    slice = reduce(slice, new Set(), { type: "extension_ui_remove", sessionId: "s1", id: "first", reason: "responded" }).slice;
    expect(slice.extensionUiRequests.map((request) => request.id)).toEqual(["second"]);
    slice = reduce(slice, new Set(), { type: "agent_settled" }).slice;
    expect(slice.extensionUiRequests).toEqual([]);
  });

  it("dismisses a pending dialog when its runtime stops", () => {
    const pending = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request",
      sessionId: "s1",
      id: "r1",
      method: "confirm",
    }).slice;
    const failed = reduce(pending, new Set(), { type: "runtime_error", error: "crashed" }).slice;
    expect(failed.extensionUiRequests).toEqual([]);
    expect(failed.runState).toBe("failed");
  });

  it("turns notify into a fire-and-forget notice with the given severity", () => {
    const { slice } = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request",
      id: "r2",
      method: "notify",
      message: "Indexed 12 files",
      notifyType: "warning",
    });
    expect(slice.extensionUiRequests).toEqual([]);
    expect(slice.notices.at(-1)).toMatchObject({ kind: "warning", text: "Indexed 12 files" });
  });

  it("tracks setStatus entries and removes them when cleared", () => {
    const withStatus = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request",
      id: "r3",
      method: "setStatus",
      statusKey: "linter",
      statusText: "linting…",
    });
    expect(withStatus.slice.statuses).toEqual({ linter: "linting…" });

    const cleared = reduce(withStatus.slice, new Set(), {
      type: "extension_ui_request",
      id: "r4",
      method: "setStatus",
      statusKey: "linter",
      statusText: undefined,
    });
    expect(cleared.slice.statuses).toEqual({});
  });

  it("injects set_editor_text with an incrementing nonce", () => {
    const first = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request",
      id: "r5",
      method: "set_editor_text",
      text: "draft one",
    });
    expect(first.slice.editorText).toEqual({ text: "draft one", nonce: 1 });
    const second = reduce(first.slice, new Set(), {
      type: "extension_ui_request",
      id: "r6",
      method: "set_editor_text",
      text: "draft two",
    });
    expect(second.slice.editorText).toEqual({ text: "draft two", nonce: 2 });
  });

  it("maps setTitle to the window title", () => {
    const { slice } = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request",
      id: "r7",
      method: "setTitle",
      title: "Running tests",
    });
    expect(slice.windowTitle).toBe("Running tests");
  });
});

describe("truthful change reporting", () => {
  it("creates fresh pending queue arrays for every slice", () => {
    const first = emptyEventSlice();
    const second = emptyEventSlice();
    first.queue.steering.push("one");
    expect(second.queue).toEqual({ steering: [], followUp: [] });
  });

  it("returns the same slice reference and changed=false for unknown events", () => {
    const slice = emptyEventSlice();
    const result = reduce(slice, new Set(), { type: "future_wire_event", data: 1 });
    expect(result.changed).toBe(false);
    expect(result.resync).toBe(false);
    expect(result.slice).toBe(slice);
  });

  it("projects setWidget into the bounded generic extension surface and clears by key", () => {
    const slice = emptyEventSlice();
    const shown = reduce(slice, new Set(), {
      type: "extension_ui_request",
      id: "w1",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["one", "two"],
      extensionPath: "extensions/plan.ts",
      extensionDisplays: [{
        id: "setWidget:plan", method: "setWidget", attribution: "extensions/plan.ts · plan", payload: { widgetLines: ["one", "two"] },
      }],
    });
    expect(shown.changed).toBe(true);
    expect(shown.slice.extensionDisplays).toEqual([
      expect.objectContaining({ id: "setWidget:plan", method: "setWidget", attribution: "extensions/plan.ts · plan" }),
    ]);
    expect(shown.slice.extensionUiRequests).toEqual([]);

    const bounded = reduce(shown.slice, new Set(), {
      type: "extension_ui_request",
      id: "w1",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["unbounded wire value"],
      extensionDisplays: [{
        id: "setWidget:plan", method: "setWidget", attribution: "extensions/plan.ts · plan",
        payload: { truncated: true, preview: "bounded" },
      }],
    });
    expect(bounded.slice.extensionDisplays[0]?.payload).toEqual({ truncated: true, preview: "bounded" });

    const cleared = reduce(bounded.slice, new Set(), {
      type: "extension_ui_request",
      id: "w2",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: undefined,
      extensionDisplays: [],
    });
    expect(cleared.slice.extensionDisplays).toEqual([]);
  });

  it("shows unknown response-bearing methods as unsupported dialogs", () => {
    const result = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request",
      sessionId: "s1",
      id: "future-1",
      method: "chooseFiles",
      title: "Choose files",
      paths: ["a", "b"],
    });
    expect(result.slice.extensionUiRequests).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        id: "future-1",
        method: "chooseFiles",
        unsupported: true,
      }),
    ]);
  });

  it("uses the generic surface for explicitly one-way future display methods", () => {
    const result = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request",
      id: "display-1",
      method: "showPanel",
      responseRequired: false,
      content: { title: "Build", lines: ["passing"] },
      extensionDisplays: [{ id: "showPanel:display-1", method: "showPanel", attribution: "Pi extension · display-1", payload: { title: "Build" } }],
    });
    expect(result.slice.extensionUiRequests).toEqual([]);
    expect(result.slice.extensionDisplays[0]).toMatchObject({ method: "showPanel" });
  });

  it("never reconstructs a generic display from an unprojected raw event", () => {
    const result = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request", id: "raw", method: "setWidget", widgetKey: "raw", widgetLines: ["secret"],
    });
    expect(result.slice.extensionDisplays).toEqual([]);
  });

  it("reports changed=true and a fresh slice for state-bearing events", () => {
    const slice = emptyEventSlice();
    const result = reduce(slice, new Set(), { type: "agent_start" });
    expect(result.changed).toBe(true);
    expect(result.slice).not.toBe(slice);
    expect(result.slice.runState).toBe("running");
  });
});
