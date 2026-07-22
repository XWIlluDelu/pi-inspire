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
    expect(start.slice.runState).toBe("running");
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

  it("appends genuinely new messages in source order", () => {
    const slice = emptyEventSlice();
    const first = reduce(slice, new Set(), { type: "message_start", message: { role: "user", content: "a", timestamp: 1 } });
    const second = reduce(first.slice, new Set(), {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: 2 },
    });
    expect(second.slice.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("requests an authoritative resync on settle and clears transient activity", () => {
    const slice = emptyEventSlice();
    slice.tools = { t1: { id: "t1", name: "bash", phase: "running" } };
    slice.retry = { attempt: 1, maxAttempts: 3, message: "x" };
    slice.queue = { steering: 1, followUp: 2 };
    const { slice: next, resync } = reduce(slice, new Set(), { type: "agent_settled" });
    expect(resync).toBe(true);
    expect(next.streaming).toBe(false);
    expect(next.tools).toEqual({});
    expect(next.retry).toBeNull();
    expect(next.queue).toEqual({ steering: 0, followUp: 0 });
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

  it("counts queued steering and follow-up input", () => {
    const { slice } = reduce(emptyEventSlice(), new Set(), {
      type: "queue_update",
      steering: ["a"],
      followUp: ["b", "c"],
    });
    expect(slice.queue).toEqual({ steering: 1, followUp: 2 });
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
      id: "r1",
      method: "select",
      title: "Pick one",
      options: ["a", "b"],
    });
    expect(slice.extensionUi).toEqual({
      id: "r1",
      method: "select",
      title: "Pick one",
      message: undefined,
      options: ["a", "b"],
      placeholder: undefined,
      prefill: undefined,
    });
  });

  it("turns notify into a fire-and-forget notice with the given severity", () => {
    const { slice } = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request",
      id: "r2",
      method: "notify",
      message: "Indexed 12 files",
      notifyType: "warning",
    });
    expect(slice.extensionUi).toBeNull();
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
  it("returns the same slice reference and changed=false for unknown events", () => {
    const slice = emptyEventSlice();
    const result = reduce(slice, new Set(), { type: "future_wire_event", data: 1 });
    expect(result.changed).toBe(false);
    expect(result.resync).toBe(false);
    expect(result.slice).toBe(slice);
  });

  it("treats a setWidget request (no truthful web surface) as a no-op", () => {
    const slice = emptyEventSlice();
    const result = reduce(slice, new Set(), {
      type: "extension_ui_request",
      id: "w1",
      method: "setWidget",
    });
    expect(result.changed).toBe(false);
    expect(result.slice).toBe(slice);
  });

  it("reports changed=true and a fresh slice for state-bearing events", () => {
    const slice = emptyEventSlice();
    const result = reduce(slice, new Set(), { type: "agent_start" });
    expect(result.changed).toBe(true);
    expect(result.slice).not.toBe(slice);
    expect(result.slice.runState).toBe("running");
  });
});
