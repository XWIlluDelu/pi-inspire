import { describe, expect, it } from "vitest";
import { MAX_EXTENSION_STATUS_CHARS } from "../../shared/contracts";
import {
  type ChatMessage,
  emptyEventSlice,
  reduceEvent as reduce,
  type WireEvent,
} from "../../src/events";
import { pendingQueues } from "./pending-fixtures";

function observe(slice = emptyEventSlice()) {
  const settled = new Set<string>();
  return (event: WireEvent) => {
    const result = reduce(slice, settled, event);
    slice = result.slice;
    for (const key of result.settle) settled.add(key);
    return result;
  };
}

function assistantText(text: string, timestamp = 2): ChatMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

describe("message reconciliation", () => {
  it("replays compacted tool argument batches across snapshots and rejects revision/identity gaps", () => {
    const settled = new Set<string>();
    const start = reduce(emptyEventSlice(), settled, {
      type: "message_start",
      message: {
        role: "assistant",
        timestamp: 2,
        content: [],
        __inspireLiveId: "stream-write",
        __inspireStreamRevision: 0,
      },
    });
    const shell = reduce(start.slice, settled, {
      type: "message_update_batch",
      streamMessageKey: "live:stream-write",
      streamRevision: 1,
      streamTextLength: 0,
      sourceEventCount: 1,
      assistantMessageEvents: [
        {
          type: "toolcall_start",
          contentIndex: 0,
          id: "write-1",
          toolName: "write",
        },
      ],
    });
    expect(shell.resync).toBe(false);
    expect(shell.slice.messages[0]).toMatchObject({
      content: [
        {
          id: "write-1",
          name: "write",
          arguments: {},
          __inspireToolCall: { phase: "streaming" },
        },
      ],
    });
    const batch: WireEvent = {
      type: "message_update_batch",
      streamMessageKey: "live:stream-write",
      streamRevision: 8,
      streamTextLength: 16,
      sourceEventCount: 7,
      assistantMessageEvents: [
        {
          type: "toolcall_delta",
          contentIndex: 0,
          argumentChars: 16,
          argumentsTruncated: false,
          argumentUpdates: [
            { path: ["path"], set: "src/file.ts" },
            { path: ["content"], set: "first" },
          ],
        },
      ],
    };
    const preview = reduce(shell.slice, settled, batch);
    expect(preview.resync).toBe(false);
    expect(preview.slice.messages[0]).toMatchObject({
      __inspireStreamRevision: 8,
      content: [{ arguments: { content: "first" } }],
    });
    expect(reduce(preview.slice, settled, batch).resync).toBe(true);
    expect(
      reduce(shell.slice, settled, { ...batch, sourceEventCount: 6 }).resync,
    ).toBe(true);
    expect(
      reduce(shell.slice, settled, {
        ...batch,
        streamMessageKey: "live:other-call",
      }).resync,
    ).toBe(true);
    const restored = reduce(emptyEventSlice(), settled, {
      type: "message_start",
      message: preview.slice.messages[0],
    });
    const continued = reduce(restored.slice, settled, {
      type: "message_update_batch",
      streamMessageKey: "live:stream-write",
      streamRevision: 9,
      streamTextLength: 23,
      sourceEventCount: 1,
      assistantMessageEvents: [
        {
          type: "toolcall_delta",
          contentIndex: 0,
          argumentChars: 23,
          argumentsTruncated: false,
          argumentUpdates: [{ path: ["content"], append: " second" }],
        },
      ],
    });
    expect(continued.resync).toBe(false);
    expect(continued.slice.messages[0]).toMatchObject({
      content: [{ arguments: { content: "first second" } }],
    });
    expect(preview.slice.messages[0]).toMatchObject({
      content: [{ arguments: { content: "first" } }],
    });
    const interrupted = reduce(continued.slice, settled, {
      type: "message_end",
      message: {
        ...continued.slice.messages[0],
        stopReason: "aborted",
      },
    });
    expect(interrupted.slice.messages[0]).toMatchObject({
      content: [{ __inspireToolCall: { phase: "interrupted" } }],
    });
  });
  it("replaces the trailing unsettled assistant message on update", () => {
    const emit = observe();
    const start = emit({ type: "message_start", message: assistantText("a") });
    expect(start.slice).toMatchObject({
      streaming: true,
      activeAssistantMessageKey: "assistant:2",
      runState: "running",
    });
    const message = assistantText("ab");
    expect(emit({ type: "message_update", message }).slice.messages).toEqual([
      message,
    ]);
  });

  it("reduces an ordered delta batch once and rejects a broken length witness", () => {
    const started = reduce(emptyEventSlice(), new Set(), {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        timestamp: 2,
        __inspireLiveId: "call-batch",
        __inspireStreamRevision: 0,
      },
    });
    const streamMessageKey = started.slice.activeAssistantMessageKey!;
    const batch = reduce(started.slice, new Set(), {
      type: "message_update_batch",
      streamMessageKey,
      streamTextLength: 5,
      streamRevision: 3,
      sourceEventCount: 3,
      assistantMessageEvents: [
        { type: "text_start", contentIndex: 0 },
        { type: "text_delta", contentIndex: 0, delta: "hel" },
        { type: "text_delta", contentIndex: 0, delta: "lo" },
      ],
    });
    expect(batch.changed).toBe(true);
    expect(batch.resync).toBe(false);
    expect(batch.slice.messages[0]!.content).toEqual([
      { type: "text", text: "hello" },
    ]);

    const broken = reduce(batch.slice, new Set(), {
      type: "message_update_batch",
      streamMessageKey,
      streamTextLength: 99,
      streamRevision: 4,
      sourceEventCount: 1,
      assistantMessageEvents: [
        { type: "text_delta", contentIndex: 0, delta: "!" },
      ],
    });
    expect(broken.resync).toBe(true);
    expect(broken.slice.messages).toBe(batch.slice.messages);
  });

  it("does not let a joining backlog regress a newer snapshot projection", () => {
    const emit = observe();
    const liveId = "call-overlap";
    emit({
      type: "message_start",
      message: {
        ...assistantText(""),
        content: [],
        __inspireLiveId: liveId,
        __inspireStreamRevision: 0,
      },
    });
    const update = (text: string, revision: number) =>
      emit({
        type: "message_update",
        streamDelta: true,
        streamMessageKey: `live:${liveId}`,
        streamTextLength: text.length,
        streamRevision: revision,
        message: {
          ...assistantText(text),
          __inspireLiveId: liveId,
          __inspireStreamRevision: revision,
        },
      });
    const atThree = update("abc", 3);
    expect(update("ab", 2)).toMatchObject({
      changed: false,
      resync: false,
      slice: { messages: atThree.slice.messages },
    });
    const advanced = update("abcd", 4);
    expect(advanced.resync).toBe(false);
    expect(advanced.slice.messages[0]).toMatchObject({
      __inspireStreamRevision: 4,
      content: [{ type: "text", text: "abcd" }],
    });
  });

  it("resyncs rather than applying a delta when no assistant call is active", () => {
    const slice = emptyEventSlice();
    slice.messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "settled" }],
        timestamp: 1,
      },
    ];
    const result = reduce(slice, new Set(["assistant:1"]), {
      type: "message_update_batch",
      streamMessageKey: "live:orphan",
      streamRevision: 1,
      streamTextLength: 6,
      sourceEventCount: 1,
      assistantMessageEvents: [
        { type: "text_delta", contentIndex: 0, delta: "orphan" },
      ],
    });
    expect(result.resync).toBe(true);
    expect(result.slice.messages).toBe(slice.messages);
    expect(result.slice.messages[0]!.content).toEqual([
      { type: "text", text: "settled" },
    ]);
  });

  it("keeps an observed completed call queued until execution is observed", () => {
    const message = {
      role: "assistant",
      timestamp: 7,
      content: [
        {
          type: "toolCall",
          id: "queued",
          name: "write",
          arguments: { path: "a.ts", content: "ready" },
        },
      ],
    };
    const started = reduce(emptyEventSlice(), new Set(), {
      type: "message_start",
      message,
    });
    const ended = reduce(started.slice, new Set(), {
      type: "message_end",
      message,
    });
    expect(ended.slice.streaming).toBe(false);
    expect(ended.slice.tools.queued).toEqual({
      id: "queued",
      name: "write",
      phase: "queued",
    });
    const executing = reduce(ended.slice, new Set(), {
      type: "tool_execution_update",
      toolCallId: "queued",
      toolName: "write",
      outputPreview: { text: "Writing…", truncated: false },
    });
    expect(executing.slice.tools.queued?.phase).toBe("running");
    const replayed = reduce(executing.slice, new Set(), {
      type: "message_end",
      message,
    });
    expect(replayed.slice.tools.queued?.phase).toBe("running");
    const settled = reduce(ended.slice, new Set(), { type: "agent_settled" });
    expect(settled.slice.tools).toEqual({});
  });

  it("does not infer a queued execution from unobserved or interrupted calls", () => {
    const call = {
      type: "toolCall",
      id: "unobserved",
      name: "write",
      arguments: { path: "a.ts" },
    };
    const message = { role: "assistant", timestamp: 7, content: [call] };
    expect(
      reduce(emptyEventSlice(), new Set(), { type: "message_end", message })
        .slice.tools,
    ).toEqual({});
    const started = reduce(emptyEventSlice(), new Set(), {
      type: "message_start",
      message,
    });
    for (const stopReason of ["aborted", "error"]) {
      const ended = reduce(started.slice, new Set(), {
        type: "message_end",
        message: { ...message, stopReason },
      });
      expect(ended.slice.tools).toEqual({});
    }
    const partial = reduce(started.slice, new Set(), {
      type: "message_end",
      message: {
        ...message,
        content: [
          {
            ...call,
            __inspireToolCall: {
              phase: "streaming",
              characters: 12,
              truncated: false,
            },
          },
        ],
      },
    });
    expect(partial.slice.tools).toEqual({});
  });

  it("keeps same-timestamp lifecycles distinct and ignores a replay of a settled live identity", () => {
    const emit = observe();
    const first = {
      role: "assistant",
      content: "first",
      timestamp: 2,
      __inspireLiveId: "first",
    };
    const second = { ...first, content: "second", __inspireLiveId: "second" };
    for (const message of [first, second]) {
      emit({ type: "message_start", message });
      const ended = emit({ type: "message_end", message });
      const key = `live:${message.__inspireLiveId}`;
      expect(ended.slice.activeAssistantMessageKey).toBe(key);
      expect(ended.slice.streaming).toBe(false);
      expect(ended.settle).toEqual([key]);
    }
    const replay = emit({ type: "message_start", message: first });
    expect(replay.changed).toBe(false);
    expect(replay.slice.messages.map(({ content }) => content)).toEqual([
      "first",
      "second",
    ]);
  });

  it("does not overwrite an older keyed turn when its end event is absent", () => {
    const slice = emptyEventSlice();
    const first = assistantText("first answer");
    slice.messages = [
      first,
      { role: "user", content: "second question", timestamp: 3 },
    ];
    const second = assistantText("second answer", 4);
    const next = reduce(slice, new Set(), {
      type: "message_start",
      message: second,
    });
    expect(next.slice.messages).toEqual([...slice.messages, second]);
  });

  it("refreshes the snapshot after a handled prompt without inventing an agent settlement", () => {
    const slice = emptyEventSlice();
    slice.runState = "running";
    slice.streaming = true;
    slice.activeAssistantMessageKey = "live:retained";
    slice.queue = pendingQueues(["steer"], ["later"]);
    const result = reduce(slice, new Set(), { type: "prompt_finished" });
    expect(result.resync).toBe(true);
    expect(result.slice).toEqual(slice);
    expect(result.settle).toEqual([]);
  });

  it("resyncs on settle without discarding the Host's pending-input projection", () => {
    const slice = emptyEventSlice();
    slice.activeAssistantMessageKey = "live:active-assistant";
    slice.tools = { t1: { id: "t1", name: "bash", phase: "running" } };
    slice.retry = { attempt: 1, maxAttempts: 3, message: "x" };
    slice.queue = pendingQueues(["steer"], ["later one", "later two"], {
      revision: 4,
    });
    const { slice: next, resync } = reduce(slice, new Set(), {
      type: "agent_settled",
    });
    expect(resync).toBe(true);
    expect(next.streaming).toBe(false);
    expect(next.activeAssistantMessageKey).toBeNull();
    expect(next.tools).toEqual({});
    expect(next.retry).toBeNull();
    expect(next.queue).toEqual(slice.queue);
  });
});

describe("transient tool/retry/queue activity", () => {
  it("maps auto-retry start/end into run state and retry info", () => {
    const slice = emptyEventSlice();
    const started = reduce(slice, new Set(), {
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 5,
      errorMessage: "rate limited",
    });
    expect(started.slice.runState).toBe("retrying");
    expect(started.slice.retry).toEqual({
      attempt: 2,
      maxAttempts: 5,
      message: "rate limited",
    });

    const recovered = reduce(started.slice, new Set(), {
      type: "auto_retry_end",
      success: true,
      attempt: 2,
    });
    expect(recovered.slice.runState).toBe("running");
    expect(recovered.slice.retry).toBeNull();

    const failed = reduce(started.slice, new Set(), {
      type: "auto_retry_end",
      success: false,
      attempt: 5,
      finalError: "overloaded",
    });
    expect(failed.slice.runState).toBe("failed");
    expect(failed.slice.notices).toEqual([]);
    const settled = reduce(failed.slice, new Set(), {
      type: "agent_settled",
      aborted: false,
    });
    expect(settled.slice.notices.at(-1)).toMatchObject({
      kind: "error",
      text: "Retry failed: overloaded",
    });
  });

  it.each(["retry", "completed message"])(
    "uses run-level cancellation after %s without erasing diagnostics",
    (phase) => {
      const emit = observe();
      emit({ type: "agent_start" });
      emit({
        type: "extension_error",
        error: "earlier diagnostic",
      });
      const message = {
        role: "assistant",
        content: "finished",
        timestamp: 1,
        stopReason: "stop",
      };
      emit(
        phase === "retry"
          ? {
              type: "auto_retry_end",
              success: false,
              finalError: "Retry cancelled",
            }
          : { type: "message_end", message },
      );
      const { slice } = emit({
        type: "agent_settled",
        aborted: true,
      });
      expect(slice.runState).toBe("aborted");
      expect(slice.notices.map(({ text }) => text)).toEqual([
        "Extension error: earlier diagnostic",
      ]);
      if (phase === "completed message")
        expect(slice.messages[0]?.stopReason).toBe("stop");
      const conflicted = reduce({ ...slice, runState: "conflict" }, new Set(), {
        type: "agent_settled",
        aborted: true,
      });
      expect(conflicted.slice.runState).toBe("conflict");
    },
  );
});

describe("extension_ui_request mapping", () => {
  it("queues concurrent dialogs in arrival order and removes only the addressed request", () => {
    const emit = observe();
    const first = {
      type: "extension_ui_request",
      sessionId: "s1",
      id: "first",
      method: "select",
      title: "Pick one",
      options: ["a", "b"],
      timeout: 1_000,
      expiresAt: 2_000,
    };
    emit(first);
    const second = {
      type: "extension_ui_request",
      sessionId: "s1",
      id: "second",
      method: "input",
    };
    const { type: _eventType, ...selection } = first;
    expect(emit(second).slice.extensionUiRequests).toMatchObject([
      selection,
      { id: second.id },
    ]);

    const removed = emit({
      type: "extension_ui_remove",
      sessionId: "s1",
      id: "first",
      reason: "responded",
    });
    expect(removed.slice.extensionUiRequests).toMatchObject([
      { id: second.id },
    ]);
    expect(emit({ type: "agent_settled" }).slice.extensionUiRequests).toEqual(
      removed.slice.extensionUiRequests,
    );
    expect(
      emit({ type: "extension_ui_clear", reason: "stopped" }).slice
        .extensionUiRequests,
    ).toEqual([]);
  });

  it("clears browser-only liveness when a runtime dies without settling", () => {
    const pending = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request",
      sessionId: "s1",
      id: "r1",
      method: "confirm",
    }).slice;
    const result = reduce(
      {
        ...pending,
        streaming: true,
        activeAssistantMessageKey: "live:call-1",
        tools: {
          tool: { id: "tool", name: "read", phase: "running" },
        },
        retry: { attempt: 2, maxAttempts: 3, message: "network" },
        statuses: { usage: "37%" },
        extensionDisplays: [
          {
            id: "setWidget:plan",
            kind: "widget",
            label: "plan",
            source: "Pi extension",
            placement: "aboveEditor",
            lines: ["one"],
          },
        ],
      },
      new Set(),
      {
        type: "runtime_error",
        error: "crashed",
        extensionDisplays: [],
        extensionStatuses: {},
      },
    );
    expect(result.resync).toBe(true);
    expect(result.slice).toMatchObject({
      runState: "failed",
      streaming: false,
      activeAssistantMessageKey: null,
      tools: {},
      retry: null,
      extensionUiRequests: [],
      extensionDisplays: [],
      statuses: {},
    });
  });

  it.each([
    [
      "exited",
      "The attached Pi exited; this session continues in Inspire. The outcome of its last task is unknown.",
    ],
    [
      "left-session",
      "The attached Pi opened another session; this session continues in Inspire. Its work may continue there.",
    ],
    [
      "left-branch",
      "The attached Pi moved to another branch; this session continues in Inspire. Its work may continue there.",
    ],
    [
      "unreachable",
      "The attached Pi stopped responding; this session continues in Inspire. Its work may continue there.",
    ],
  ])(
    "settles a released busy attachment (%s) without a failure",
    (reason, notice) => {
      const result = reduce(
        { ...emptyEventSlice(), runState: "running", streaming: true },
        new Set(),
        { type: "external_attachment_ended", reason, duringWork: true },
      );
      expect(result.resync).toBe(true);
      expect(result.slice).toMatchObject({
        runState: "idle",
        streaming: false,
      });
      expect(result.slice.notices.at(-1)).toMatchObject({
        kind: "info",
        text: notice,
      });
    },
  );

  it("resyncs when a controlled worker stop retires the branch view", () => {
    expect(
      reduce(emptyEventSlice(), new Set(), {
        type: "extension_runtime_stopped",
        extensionDisplays: [],
        extensionStatuses: {},
      }).resync,
    ).toBe(true);
  });

  it("replaces setStatus state from the authoritative Host projection", () => {
    const withStatus = reduce(emptyEventSlice(), new Set(), {
      type: "extension_ui_request",
      id: "r3",
      method: "setStatus",
      extensionStatuses: {
        linter: "linting…",
        oversized: "x".repeat(MAX_EXTENSION_STATUS_CHARS + 1),
        invalid: 4,
      },
    });
    expect(withStatus.slice.statuses).toEqual({ linter: "linting…" });

    const cleared = reduce(withStatus.slice, new Set(), {
      type: "extension_ui_request",
      id: "r4",
      method: "setStatus",
      extensionStatuses: {},
    });
    expect(cleared.slice.statuses).toEqual({});
  });

  it("updates widgets only from bounded Host projections", () => {
    const initial = emptyEventSlice();
    const widget = {
      type: "extension_ui_request",
      id: "widget",
      method: "setWidget",
      widgetKey: "plan",
      widgetLines: ["unprojected secret"],
    };
    const raw = reduce(initial, new Set(), widget);
    expect(raw.slice.extensionDisplays).toEqual([]);

    const shown = reduce(raw.slice, new Set(), {
      ...widget,
      extensionDisplays: [
        {
          id: "setWidget:plan",
          kind: "widget",
          label: "plan",
          source: "extensions/plan.ts",
          placement: "belowEditor",
          lines: ["one", "two"],
        },
      ],
    });
    expect(shown.changed).toBe(true);
    expect(shown.slice.extensionUiRequests).toEqual([]);
    expect(shown.slice.extensionDisplays[0]).toMatchObject({
      kind: "widget",
      placement: "belowEditor",
      lines: ["one", "two"],
    });

    const cleared = reduce(shown.slice, new Set(), {
      ...widget,
      extensionDisplays: [],
    });
    expect(cleared.slice.extensionDisplays).toEqual([]);
  });
});
