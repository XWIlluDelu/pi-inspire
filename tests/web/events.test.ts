import { expect, it } from "vitest";
import {
  MAX_EXTENSION_STATUS_CHARS,
  MAX_EXTENSION_WIDGET_LINES,
} from "../../shared/contracts";
import {
  type ChatMessage,
  emptyEventSlice,
  reduceEvent as reduce,
  type WireEvent,
} from "../../src/events";
import { pendingQueues } from "./pending-fixtures";

const assistant = (
  content: ChatMessage["content"],
  liveId: string,
  revision = 0,
): ChatMessage => ({
  role: "assistant",
  content,
  timestamp: 2,
  __inspireLiveId: liveId,
  __inspireStreamRevision: revision,
});
const start = (message: ChatMessage, previous = emptyEventSlice()) =>
  reduce(previous, { type: "message_start", message });

function observe(slice = emptyEventSlice()) {
  return (type: string, fields: Omit<WireEvent, "type"> = {}) => {
    const result = reduce(slice, { type, ...fields });
    slice = result.slice;
    return result;
  };
}

it("applies compacted arguments after a joined preview and rejects replayed, malformed and orphan batches", () => {
  const initial = start(assistant([], "stream"));
  const key = "live:stream";
  const shell = reduce(initial.slice, {
    type: "message_update_batch",
    streamMessageKey: key,
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
  }).slice;
  expect(shell.messages[0]).toMatchObject({
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
    streamMessageKey: key,
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
  const preview = reduce(shell, batch);
  expect(preview).toMatchObject({
    resync: false,
    slice: {
      messages: [
        {
          __inspireStreamRevision: 8,
          content: [{ arguments: { content: "first" } }],
        },
      ],
    },
  });
  for (const [base, invalid] of [
    [preview.slice, batch],
    [shell, { ...batch, sourceEventCount: 6 }],
    [shell, { ...batch, streamMessageKey: "live:foreign" }],
    [shell, { ...batch, streamTextLength: 99 }],
    [{ ...preview.slice, activeAssistantMessageKey: null }, batch],
  ] as const) {
    const refused = reduce(base, invalid);
    expect(refused.resync).toBe(true);
    expect(refused.slice.messages).toBe(base.messages);
  }

  const restored = start(preview.slice.messages[0]!).slice;
  const continued = reduce(restored, {
    ...batch,
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
  expect(continued).toMatchObject({
    resync: false,
    slice: {
      messages: [{ content: [{ arguments: { content: "first second" } }] }],
    },
  });
  expect(preview.slice.messages[0]).toMatchObject({
    content: [{ arguments: { content: "first" } }],
  });
  expect(
    reduce(continued.slice, {
      type: "message_end",
      message: { ...continued.slice.messages[0], stopReason: "aborted" },
    }).slice.messages[0],
  ).toMatchObject({
    content: [{ __inspireToolCall: { phase: "interrupted" } }],
  });
});

it("keeps same-timestamp turns separate, drops stale cumulative text, and applies queued tools with settlement", () => {
  const emit = observe();
  const first = assistant([], "first");
  emit("message_start", { message: first });
  const batch = emit("message_update_batch", {
    streamMessageKey: "live:first",
    streamTextLength: 5,
    streamRevision: 3,
    sourceEventCount: 3,
    assistantMessageEvents: [
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "hel" },
      { type: "text_delta", contentIndex: 0, delta: "lo" },
    ],
  });
  const text = [{ type: "text", text: "hello" }];
  expect(batch).toMatchObject({
    changed: true,
    resync: false,
    slice: { messages: [{ content: text }] },
  });
  expect(
    emit("message_update", {
      streamDelta: true,
      streamMessageKey: "live:first",
      streamTextLength: 3,
      streamRevision: 2,
      message: assistant([{ type: "text", text: "hel" }], "first", 2),
    }),
  ).toMatchObject({
    changed: false,
    resync: false,
    slice: { messages: batch.slice.messages },
  });
  const current = assistant([{ type: "text", text: "hello!" }], "first", 4);
  expect(emit("message_update", { message: current }).slice.messages).toEqual([
    current,
  ]);

  // A new identity can arrive even if the prior message_end was never delivered.
  const second = assistant("second", "second");
  expect(emit("message_start", { message: second }).slice.messages).toEqual([
    current,
    second,
  ]);
  const tool = { id: "read-1", name: "read", phase: "queued" } as const;
  const ended = emit("message_end", {
    message: second,
    toolActivity: { [tool.id]: tool },
  });
  expect(ended.slice).toMatchObject({
    activeAssistantMessageKey: "live:second",
    streaming: false,
    tools: { [tool.id]: tool },
    messages: [current, { ...second, __inspireSettled: true }],
  });
  expect(emit("message_start", { message: second })).toMatchObject({
    changed: false,
    slice: ended.slice,
  });
});

it.each([false, true])(
  "retains Pending and stops retry presentation only on settlement (aborted: %s)",
  (aborted) => {
    const queue = pendingQueues(["steer"], ["later"], { revision: 4 });
    const emit = observe({
      ...emptyEventSlice(),
      streaming: true,
      activeAssistantMessageKey: "live:active",
      queue,
      tools: { call: { id: "call", name: "bash", phase: "running" } },
    });
    const before = emit("auto_retry_start", {
      sessionStatus: { runState: "retrying" },
      attempt: 2,
      maxAttempts: 5,
      errorMessage: "rate limited",
    }).slice;
    expect(before.retry).toEqual({
      attempt: 2,
      maxAttempts: 5,
      message: "rate limited",
    });
    expect(emit("prompt_finished")).toMatchObject({
      resync: true,
      slice: before,
    });
    expect(
      emit("auto_retry_end", {
        sessionStatus: { runState: "failed" },
        success: false,
        finalError: "overloaded",
      }).slice,
    ).toMatchObject({ retry: null, notices: [] });
    const settled = emit("agent_settled", {
      aborted,
      sessionStatus: { runState: aborted ? "aborted" : "failed" },
    });
    expect(settled).toMatchObject({
      resync: true,
      slice: {
        streaming: false,
        activeAssistantMessageKey: null,
        tools: {},
        retry: null,
        queue,
      },
    });
    expect(settled.slice.notices.map(({ text }) => text)).toEqual(
      aborted ? [] : ["Retry failed: overloaded"],
    );
  },
);

it("keeps the remaining addressed dialog through ordinary settlement and retires it on Stop or crash", () => {
  const emit = observe();
  const first = {
    sessionId: "s1",
    id: "first",
    method: "select",
    title: "Pick one",
    options: ["a", "b"],
    timeout: 1000,
    expiresAt: 2000,
  };
  const second = { sessionId: "s1", id: "second", method: "input" };
  emit("extension_ui_request", first);
  expect(
    emit("extension_ui_request", second).slice.extensionUiRequests,
  ).toMatchObject([first, second]);
  expect(
    emit("extension_ui_remove", {
      sessionId: "s1",
      id: first.id,
      reason: "responded",
    }).slice.extensionUiRequests,
  ).toMatchObject([second]);
  const settled = emit("agent_settled").slice;
  expect(settled.extensionUiRequests).toMatchObject([second]);
  expect(
    emit("extension_ui_clear", { reason: "stopped" }).slice.extensionUiRequests,
  ).toEqual([]);

  const crashed = reduce(
    {
      ...settled,
      streaming: true,
      activeAssistantMessageKey: "live:retired",
      statuses: { usage: "37%" },
      tools: { tool: { id: "tool", name: "read", phase: "running" } },
      retry: { attempt: 2, maxAttempts: 3, message: "network" },
      queue: pendingQueues(["retired input"]),
      extensionDisplays: [
        {
          id: "plan",
          kind: "widget",
          label: "plan",
          source: "Pi extension",
          placement: "aboveEditor",
          lines: ["one"],
        },
      ],
    },
    {
      type: "runtime_error",
      error: "crashed",
      extensionDisplays: [],
      extensionStatuses: {},
    },
  );
  expect(crashed).toMatchObject({
    resync: true,
    slice: {
      streaming: false,
      activeAssistantMessageKey: null,
      tools: {},
      retry: null,
      extensionUiRequests: [],
      extensionDisplays: [],
      statuses: {},
      queue: pendingQueues(),
      notices: [{ kind: "error", text: "Pi runtime stopped: crashed" }],
    },
  });
  expect(emit("extension_runtime_stopped").resync).toBe(true);
});

it.each([
  ["exited", "exited", "The outcome of its last task is unknown."],
  ["left-session", "opened another session", "Its work may continue there."],
  ["left-branch", "moved to another branch", "Its work may continue there."],
  ["unreachable", "stopped responding", "Its work may continue there."],
] as const)(
  "retains unknown attached Pi work after %s",
  (reason, detail, outcome) => {
    const input = {
      ...emptyEventSlice(),
      streaming: true,
      activeAssistantMessageKey: "live:external",
      tools: { tool: { id: "tool", name: "read", phase: "running" as const } },
    };
    expect(
      reduce(input, {
        type: "external_attachment_ended",
        reason,
        duringWork: true,
      }),
    ).toMatchObject({
      resync: true,
      slice: {
        streaming: false,
        activeAssistantMessageKey: null,
        tools: {},
        notices: [
          {
            kind: "info",
            text: `The attached Pi ${detail}; this session continues in Inspire. ${outcome}`,
          },
        ],
      },
    });
  },
);

it("replaces extension status and widgets from bounded Host projections", () => {
  const emit = observe();
  const widget = {
    id: "widget",
    method: "setWidget",
    widgetLines: ["unprojected secret"],
  };
  expect(emit("extension_ui_request", widget).slice.extensionDisplays).toEqual(
    [],
  );
  const valid = {
    id: "plan",
    kind: "widget",
    label: "plan",
    source: "extensions/plan.ts",
    placement: "belowEditor",
    lines: ["one", "two"],
  };
  const status = {
    id: "status",
    method: "setStatus",
    extensionStatuses: {
      linter: "linting…",
      oversized: "x".repeat(MAX_EXTENSION_STATUS_CHARS + 1),
      invalid: 4,
    },
  };
  expect(emit("extension_ui_request", status).slice.statuses).toEqual({
    linter: "linting…",
  });
  expect(
    emit("extension_ui_request", {
      ...widget,
      extensionDisplays: [
        valid,
        {
          ...valid,
          id: "oversized",
          lines: Array(MAX_EXTENSION_WIDGET_LINES + 1).fill("large"),
        },
      ],
    }),
  ).toMatchObject({
    changed: true,
    slice: { extensionUiRequests: [], extensionDisplays: [valid] },
  });
  emit("extension_ui_request", { ...status, extensionStatuses: {} });
  expect(
    emit("extension_ui_request", { ...widget, extensionDisplays: [] }).slice,
  ).toMatchObject({ statuses: {}, extensionDisplays: [] });
});
