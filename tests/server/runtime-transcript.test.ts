import { appendFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  TRANSCRIPT_PAGE_MAX_BYTES,
  TRANSIENT_OVERLAY_MAX_BYTES,
} from "../../server/session-projection.js";
import {
  disposeProjectionFixture,
  initializeProjectionFixture,
  setup,
} from "./fixtures/runtime-projection.js";
import { jsonl, messageEntry } from "./fixtures/session-jsonl.js";

const id = "session-a";
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
beforeEach(initializeProjectionFixture);
afterEach(disposeProjectionFixture);

async function fixture() {
  const {
    runtime,
    workers: [worker],
    path,
    startup,
  } = await setup();
  await startup;
  const events: Record<string, unknown>[] = [];
  runtime.on("event", (event) => events.push(event));
  const emit = (type: string, fields: Record<string, unknown> = {}) =>
    worker!.emit("event", { type, ...fields });
  const snapshot = () => runtime.snapshot(id);
  return {
    runtime,
    worker: worker!,
    events,
    emit,
    snapshot,
    active: async () => (await snapshot()).active!,
    messages: async () =>
      (await snapshot()).active!.transcriptPage.messages as Record<
        string,
        unknown
      >[],
    end: (message: Record<string, unknown>) => emit("message_end", { message }),
    append: (...entries: unknown[]) => appendFile(path, jsonl(...entries)),
    status: async () => (await snapshot()).sessionStatuses[id]?.runState,
  };
}

type StopCase = {
  label: string;
  stopReason?: "error" | "aborted" | "stop";
  content?: unknown;
  cancelled?: boolean;
  state: "failed" | "aborted";
};
const stopCases: StopCase[] = [
  {
    label: "empty provider error",
    stopReason: "error",
    content: [],
    state: "failed",
  },
  {
    label: "partial provider text",
    stopReason: "error",
    content: [{ type: "text", text: "partial output" }],
    state: "failed",
  },
  {
    label: "interrupted tool call",
    stopReason: "error",
    content: [
      {
        type: "toolCall",
        id: "interrupted-write",
        name: "write",
        arguments: { path: "src/partial.ts", content: "unfinished" },
      },
    ],
    state: "failed",
  },
  {
    label: "native abort",
    stopReason: "aborted",
    content: [],
    state: "aborted",
  },
  {
    label: "provider error during Stop",
    stopReason: "error",
    content: [],
    cancelled: true,
    state: "aborted",
  },
  {
    label: "completed message during Stop",
    stopReason: "stop",
    content: "finished",
    cancelled: true,
    state: "aborted",
  },
  { label: "cancelled retry", cancelled: true, state: "aborted" },
];

it.each(stopCases)(
  "settles $label off-screen and preserves the native result",
  async ({ stopReason, content, cancelled, state }) => {
    const f = await fixture();
    const outcomes: unknown[] = [];
    f.runtime.on("task_outcome", (event) => outcomes.push(event));
    await f.runtime.deselectSession();
    f.emit("agent_start");
    const message = {
      role: "assistant",
      content,
      timestamp: 2,
      stopReason,
      errorMessage: "This operation was aborted",
    };
    if (stopReason) {
      f.emit("message_start", {
        message: { role: message.role, content, timestamp: 2 },
      });
      f.end(message);
      expect(f.events.at(-1)?.message).toMatchObject(message);
      expect(await f.status()).toBe(
        stopReason === "error"
          ? "failed"
          : stopReason === "aborted"
            ? "aborted"
            : "running",
      );
      const entry = messageEntry("stopped", "u1", message);
      await f.append(entry);
      expect((await f.messages()).at(-1)).toMatchObject({
        ...message,
        __inspireLiveId: expect.any(String),
      });
      f.worker.publishCheckpoint([entry], { sealed: "settled" });
    } else
      f.emit("auto_retry_end", {
        success: false,
        finalError: "Retry cancelled",
      });
    f.emit("agent_settled", { aborted: cancelled });
    const settled = await vi.waitFor(() => {
      const event = f.events.findLast(
        (event) => event.type === "agent_settled",
      );
      expect(event).toMatchObject({ sessionStatus: { runState: state } });
      return event!;
    });
    expect(await f.status()).toBe(state);
    if (stopReason)
      expect((await f.messages()).slice(1)).toMatchObject([
        { ...message, __inspireEntryId: "stopped" },
      ]);
    if (state === "aborted")
      expect(settled.sessionStatus).not.toHaveProperty("indicator");
    expect(outcomes).toEqual(
      state === "failed"
        ? [expect.objectContaining({ outcome: "failed" })]
        : [],
    );
  },
);

it("keeps the latest output within the line, character, and wire budgets", async () => {
  const f = await fixture();
  for (const [bound, older, wireBudget] of [
    ["lines", "older output\n".repeat(25_000), 6_000],
    ["characters", "older".repeat(65_000), 17_000],
  ] as const) {
    f.emit("tool_execution_update", {
      toolCallId: bound,
      toolName: "bash",
      partialResult: {
        content: [{ type: "text", text: `${older}LATEST_OUTPUT` }],
        details: { progress: "native metadata" },
      },
    });
    const { toolActivity } = await f.active();
    const preview = toolActivity?.[bound]?.outputPreview;
    expect(preview).toMatchObject({
      truncated: true,
      text: expect.stringMatching(/LATEST_OUTPUT$/),
    });
    expect(preview!.text.length).toBeLessThanOrEqual(16_000);
    expect(preview!.text.split("\n")).toHaveLength(bound === "lines" ? 400 : 1);
    const update = f.events.findLast(
      ({ type }) => type === "tool_execution_update",
    )!;
    expect(update.toolActivity).toEqual(toolActivity);
    expect(update).not.toHaveProperty("partialResult");
    expect(jsonBytes(update)).toBeLessThan(wireBudget);
    f.emit("agent_start");
  }
});

it("bounds native Codemode receipts and keeps generic nested results scoped, redacted, and terminal", async () => {
  const f = await fixture();
  const tool = (
    phase: string,
    id: string,
    name: string,
    fields: Record<string, unknown> = {},
  ) =>
    f.emit(`tool_execution_${phase}`, {
      toolCallId: id,
      toolName: name,
      ...fields,
    });
  f.emit("agent_start");
  tool("start", "script", "codemode", { args: { code: "text('fixture')" } });
  tool("update", "script", "codemode", {
    partialResult: {
      content: [],
      details: {
        calls: Array.from({ length: 300 }, (_, index) => ({
          id: `script/${index}`,
          name: "read",
          status: "running",
          args: '{"path":"a.txt"}',
        })),
      },
    },
  });
  tool("start", "parent", "orchestrator");
  const parentToolCallId = "parent";
  tool("start", "parent/1", "read", {
    parentToolCallId,
    args: { path: "a.txt", token: "secret" },
  });
  tool("update", "parent/1", "read", {
    parentToolCallId,
    partialResult: { content: [{ type: "text", text: "PRIVATE_CHILD_OUTPUT" }] },
  });
  tool("end", "parent/1", "read", {
    parentToolCallId,
    isError: true,
    result: { content: [{ type: "text", text: "Child failed" }] },
  });
  const { toolActivity: tools } = await f.active();
  expect(Object.keys(tools!)).toEqual(["script", "parent"]);
  expect(tools?.script?.calls).toMatchObject({
    source: "codemode",
    complete: false,
  });
  expect(tools?.script?.calls?.calls).toHaveLength(256);
  expect(tools?.parent).toMatchObject({
    phase: "running",
    calls: {
      source: "nested",
      calls: [
        {
          key: "parent/1",
          status: "error",
          arguments: { path: "a.txt", token: "[redacted]" },
          error: "Child failed",
        },
      ],
    },
  });
  expect(JSON.stringify(f.events)).not.toMatch(/PRIVATE_CHILD_OUTPUT|"secret"/);
  tool("end", "parent", "orchestrator", {
    result: { content: [{ type: "text", text: "Parent succeeded" }] },
  });
  const final = (await f.active()).toolActivity?.parent;
  expect(final?.phase).toBe("done");
  const emitted = f.events.length;
  tool("update", "parent/1", "read", { parentToolCallId, partialResult: {} });
  expect((await f.active()).toolActivity?.parent).toEqual(final);
  expect(f.events).toHaveLength(emitted);
});

it("adopts native identities only at the ordered seal even for identical custom messages and equal-timestamp tool results", async () => {
  const f = await fixture();
  const payload = {
    customType: "relay_message",
    content: "same payload",
    display: true,
    details: { source: "peer" },
  };
  const custom = { role: "custom", timestamp: 2, ...payload };
  const first = {
    type: "custom_message",
    id: "custom-1",
    parentId: "u1",
    timestamp: "2026-08-01T00:00:07.000Z",
    ...payload,
  };
  const second = {
    ...first,
    id: "custom-2",
    parentId: first.id,
    timestamp: "2026-08-01T00:00:08.000Z",
  };
  const tools = ["one", "two"].map((name) => ({
    role: "toolResult",
    content: name,
    timestamp: 2,
    toolCallId: `call-${name}`,
    toolName: "read",
  }));
  const rest = [
    second,
    messageEntry("tool-1", second.id, tools[0]!),
    messageEntry("tool-2", "tool-1", tools[1]!),
  ];
  // Pi can append an idle custom entry before announcing the equivalent message.
  await f.append(first);
  f.emit("entry_appended", { entry: first });
  for (const message of [custom, custom, ...tools]) {
    f.emit("message_start", { message });
    f.end(message);
  }
  const read = async () => (await f.messages()).slice(1);
  const live = await read();
  expect(live.map((row) => row.role)).toEqual([
    "custom",
    "custom",
    "toolResult",
    "toolResult",
  ]);
  const liveIds = live.map((row) => row.__inspireLiveId);
  expect(liveIds).toEqual(Array.from({ length: 4 }, () => expect.any(String)));
  expect(new Set(liveIds).size).toBe(4);
  expect(live.every((row) => !row.__inspireEntryId)).toBe(true);
  await f.append(...rest);
  f.worker.publishCheckpoint([first], { sealed: null });
  expect(await read()).toEqual(live);
  f.worker.publishCheckpoint(rest, { sealed: null });
  expect(await read()).toEqual(live);
  f.worker.publishCheckpoint([], { sealed: "idle" });
  await vi.waitFor(async () => {
    const saved = await read();
    expect(saved).toMatchObject([
      ...[first, second].map(({ id, timestamp }) => ({
        __inspireEntryId: id,
        timestamp: Date.parse(timestamp),
        ...payload,
      })),
      ...tools.map(({ toolCallId }, index) => ({
        __inspireEntryId: `tool-${index + 1}`,
        toolCallId,
      })),
    ]);
    expect(saved.every((row) => !row.__inspireLiveId)).toBe(true);
  });
});

it("preserves ordered assistant deltas and repeated timestamps, then reads the complete sealed reply by view", async () => {
  const f = await fixture();
  const timestamp = 20;
  const start = { role: "assistant", content: [], timestamp };
  f.emit("agent_start");
  f.emit("message_start", { message: start });
  const firstId = (await f.messages()).at(-1)!.__inspireLiveId;
  const content = [
    { type: "thinking", thinking: "live thought" },
    { type: "text", text: "live answer" },
  ];
  for (const assistantMessageEvent of [
    { type: "thinking_start", contentIndex: 0 },
    { type: "thinking_delta", contentIndex: 0, delta: "live thought" },
    { type: "text_start", contentIndex: 1 },
    { type: "text_delta", contentIndex: 1, delta: "live answer" },
  ])
    f.emit("message_update", { assistantMessageEvent });
  expect(
    f.events.filter(({ type }) => type === "message_update"),
  ).toMatchObject(
    [0, 12, 12, 23].map((streamTextLength, index) => ({
      streamDelta: true,
      streamMessageKey: `live:${firstId}`,
      streamTextLength,
      streamRevision: index + 1,
    })),
  );
  expect((await f.messages()).at(-1)).toMatchObject({
    __inspireLiveId: firstId,
    __inspireStreamRevision: 4,
    content,
  });

  const call = { type: "toolCall", id: "tool-1", name: "read", arguments: {} };
  const first = {
    ...start,
    content: [...content, call],
    stopReason: "toolUse",
  };
  f.end(first);
  expect(f.events.at(-1)).toMatchObject({
    type: "message_end",
    message: { __inspireLiveId: firstId },
    toolActivity: { [call.id]: { phase: "queued" } },
  });
  const text = `${"streaming".repeat(80_000)}THE_END_42\n`;
  const second = {
    ...start,
    content: [{ type: "text", text }],
    stopReason: "stop",
  };
  f.emit("message_start", { message: second });
  f.end(second);
  const live = await f.active();
  const [firstLive, secondLive] = live.transcriptPage.messages.slice(
    1,
  ) as Record<string, unknown>[];
  expect(firstLive?.__inspireLiveId).toBe(firstId);
  expect(secondLive?.__inspireLiveId).not.toBe(firstId);
  expect(live.activeAssistantMessageKey).toBe(
    `live:${secondLive?.__inspireLiveId}`,
  );
  expect(jsonBytes(live.transcriptPage)).toBeLessThanOrEqual(
    TRANSCRIPT_PAGE_MAX_BYTES,
  );
  expect(jsonBytes(live.transcriptPage.messages)).toBeLessThanOrEqual(
    TRANSIENT_OVERLAY_MAX_BYTES,
  );

  const saved = [
    messageEntry("a1", "u1", first),
    messageEntry("a2", "a1", second),
  ];
  await f.append(...saved);
  f.worker.publishCheckpoint(saved, { sealed: "settled" });
  await vi.waitFor(async () => {
    const active = await f.active();
    expect(active.activeAssistantMessageKey).toBe("persisted:a2:0");
    expect(active.transcriptPage.messages.slice(1)).toMatchObject([
      { __inspireEntryId: "a1", __inspireTurnId: firstLive?.__inspireTurnId },
      { __inspireEntryId: "a2", __inspireTurnId: secondLive?.__inspireTurnId },
    ]);
  });
  f.emit("agent_settled");
  await vi.waitFor(async () => expect(await f.status()).toBe("idle"));
  const snapshot = await f.snapshot();
  const page = snapshot.active!.transcriptPage;
  expect(JSON.stringify(page.messages)).not.toContain("THE_END_42");
  expect(jsonBytes(snapshot)).toBeLessThan(3 * TRANSCRIPT_PAGE_MAX_BYTES);
  expect(f.worker.commands.some(({ type }) => type === "get_messages")).toBe(
    false,
  );
  expect(await f.runtime.lastAssistantText(id, page.viewId)).toEqual({ text });
  await expect(
    f.runtime.lastAssistantText(id, "stale-view"),
  ).rejects.toMatchObject({ status: 409 });
});
