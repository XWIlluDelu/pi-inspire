import { appendFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPT_PAGE_MAX_BYTES,
  TRANSIENT_OVERLAY_MAX_BYTES,
} from "../../server/session-projection.js";
import { TaskOutcomeTracker } from "../../server/task-notifications.js";

import {
  disposeProjectionFixture,
  setup,
} from "./fixtures/runtime-projection.js";
import { jsonl, messageEntry } from "./fixtures/session-jsonl.js";

afterEach(disposeProjectionFixture);

describe("live and durable transcript reconciliation", () => {
  const failedReply = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "This operation was aborted",
      timestamp: 2,
    },
  };
  it.each([
    { phase: "provider error", event: failedReply, aborted: false },
    { phase: "provider error", event: failedReply, aborted: true },
    {
      phase: "retry",
      event: {
        type: "auto_retry_end",
        success: false,
        finalError: "Retry cancelled",
      },
      aborted: true,
    },
    {
      phase: "completed message",
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          content: "finished",
          stopReason: "stop",
          timestamp: 2,
        },
      },
      aborted: true,
    },
  ])(
    "settles a background $phase using native cancellation evidence (aborted=$aborted)",
    async ({ event, aborted }) => {
      const { runtime, workers } = await setup();
      const tracker = new TaskOutcomeTracker();
      const notifications: unknown[] = [];
      const settled = vi.fn();
      runtime.on("event", (event) => {
        if (event.type === "agent_settled") settled(event);
        const notification = tracker.observe(event);
        if (notification) notifications.push(notification);
      });
      await runtime.deselectSession();
      const worker = workers[0]!;
      worker.emit("event", { type: "agent_start" });
      worker.emit("event", event);
      worker.emit("event", { type: "agent_settled", aborted });
      const runState = aborted ? "aborted" : "failed";
      await vi.waitFor(() =>
        expect(settled).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionStatus: expect.objectContaining({ runState }),
          }),
        ),
      );
      expect((await runtime.snapshot("session-a")).runState).toBe(runState);
      expect(notifications).toEqual(
        aborted ? [] : [expect.objectContaining({ outcome: "failed" })],
      );
      if (aborted)
        expect(settled.mock.calls.at(-1)?.[0].sessionStatus).not.toHaveProperty(
          "indicator",
        );
    },
  );

  it.each(["character", "line"] as const)(
    "keeps the latest output beyond general projection (%s bound)",
    async (bound) => {
      const { runtime, workers } = await setup();
      const events: Array<Record<string, unknown>> = [];
      runtime.on("event", (event) => events.push(event));
      const older =
        bound === "line"
          ? "older output\n".repeat(25_000)
          : "older".repeat(65_000);
      const text = `${older}LATEST_OUTPUT`;
      workers[0]!.emit("event", {
        type: "tool_execution_update",
        toolCallId: "long-output",
        toolName: "bash",
        partialResult: {
          content: [{ type: "text", text }],
          details: { progress: "native metadata" },
        },
      });
      const tool = (await runtime.snapshot()).active?.toolActivity?.[
        "long-output"
      ];
      expect(tool?.outputPreview?.text).toMatch(/LATEST_OUTPUT$/);
      expect(tool?.outputPreview?.truncated).toBe(true);
      expect(tool!.outputPreview!.text.length).toBeLessThanOrEqual(16_000);
      expect(tool!.outputPreview!.text.split("\n").length).toBeLessThanOrEqual(
        400,
      );
      const update = events.findLast(
        (event) => event.type === "tool_execution_update",
      )!;
      expect(update.outputPreview).toEqual(tool?.outputPreview);
      expect(update.partialResult).toEqual({
        details: { progress: "native metadata" },
      });
      expect(Buffer.byteLength(JSON.stringify(update))).toBeLessThan(
        bound === "line" ? 6_000 : 17_000,
      );
    },
  );

  it("bounds Codemode's own snapshot before transport without duplicating generic receipts", async () => {
    const { runtime, workers } = await setup();
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event));
    workers[0]!.emit("event", {
      type: "tool_execution_start",
      toolCallId: "script",
      toolName: "codemode",
      args: { code: "text('fixture')" },
    });
    workers[0]!.emit("event", {
      type: "tool_execution_update",
      toolCallId: "script",
      toolName: "codemode",
      partialResult: {
        content: [],
        details: {
          calls: Array.from({ length: 300 }, () => ({
            id: "script/?",
            name: "read",
            status: "running",
            args: '{"path":"a.txt"}',
          })),
        },
      },
    });
    workers[0]!.emit("event", {
      type: "tool_execution_start",
      parentToolCallId: "script",
      toolCallId: "script/1",
      toolName: "read",
      args: { path: "a.txt" },
    });
    const event = events.findLast(
      (event) => event.type === "tool_execution_update",
    )!;
    expect(event).toMatchObject({
      childCalls: { source: "codemode", complete: false },
    });
    expect((event.childCalls as { calls: unknown[] }).calls).toHaveLength(256);
    const activity = (await runtime.snapshot()).active?.toolActivity;
    expect(Object.keys(activity ?? {})).toEqual(["script"]);
    expect(activity?.script?.calls).toEqual(event.childCalls);
  });

  it("restores bounded parented receipts on reconnect without retaining child results", async () => {
    const { runtime, workers } = await setup();
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event));
    const emit = (event: Record<string, unknown>) =>
      workers[0]!.emit("event", event);
    emit({ type: "agent_start" });
    emit({
      type: "tool_execution_start",
      toolCallId: "parent",
      toolName: "orchestrator",
      args: {},
    });
    emit({
      type: "tool_execution_start",
      parentToolCallId: "parent",
      toolCallId: "parent/1",
      toolName: "read",
      args: { path: "a.txt", token: "secret" },
    });
    emit({
      type: "tool_execution_start",
      parentToolCallId: "parent/1",
      toolCallId: "parent/1/1",
      toolName: "read",
      args: { path: "deep.txt" },
    });
    emit({
      type: "tool_execution_update",
      parentToolCallId: "parent",
      toolCallId: "parent/1",
      toolName: "read",
      partialResult: {
        content: [{ type: "text", text: "PRIVATE_CHILD_OUTPUT" }],
        details: { rawResult: true },
      },
    });
    emit({
      type: "tool_execution_end",
      parentToolCallId: "parent",
      toolCallId: "parent/1",
      toolName: "read",
      isError: true,
      result: {
        content: [{ type: "text", text: "Child failed" }],
        details: { rawResult: true },
      },
    });
    const tools = (await runtime.snapshot()).active?.toolActivity;
    expect(Object.keys(tools!)).toEqual(["parent"]);
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
          {
            key: "parent/1/1",
            status: "running",
            arguments: { path: "deep.txt" },
          },
        ],
      },
    });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_CHILD_OUTPUT");
    expect(JSON.stringify(tools)).not.toContain("secret");
    emit({
      type: "tool_execution_end",
      toolCallId: "parent",
      toolName: "orchestrator",
      result: { content: [{ type: "text", text: "Parent succeeded" }] },
      isError: false,
    });
    expect((await runtime.snapshot()).active?.toolActivity?.parent?.phase).toBe(
      "done",
    );
    emit({
      type: "tool_execution_update",
      parentToolCallId: "parent",
      toolCallId: "parent/1",
      toolName: "read",
      partialResult: {},
    });
    expect(
      (await runtime.snapshot()).active?.toolActivity?.parent?.calls?.calls[0]
        ?.status,
    ).toBe("error");
    emit({ type: "agent_start" });
    expect((await runtime.snapshot()).active?.toolActivity).toEqual({});
  });

  it.each([
    {
      label: "an empty failed reply",
      stopReason: "error",
      content: [],
      runState: "failed",
    },
    {
      label: "partial reply text",
      stopReason: "error",
      content: [{ type: "text", text: "partial output" }],
      runState: "failed",
    },
    {
      label: "an interrupted tool call",
      stopReason: "error",
      content: [
        {
          type: "toolCall",
          id: "interrupted-write",
          name: "write",
          arguments: { path: "src/partial.ts", content: "unfinished" },
        },
      ],
      runState: "failed",
    },
    {
      label: "a native abort",
      stopReason: "aborted",
      content: [],
      runState: "aborted",
    },
  ])(
    "preserves $label across live events, reconnect and persistence",
    async ({ stopReason, content, runState }) => {
      const { runtime, workers, path } = await setup();
      const forwarded: Array<Record<string, unknown>> = [];
      runtime.on("event", (event) => {
        if (event.type === "message_end") forwarded.push(event);
      });
      const live = { role: "assistant", content, timestamp: 2 };
      const stopped = {
        ...live,
        stopReason,
        errorMessage: "This operation was aborted",
      };
      const worker = workers[0]!;
      worker.emit("event", { type: "agent_start" });
      worker.emit("event", { type: "message_start", message: live });
      worker.emit("event", { type: "message_end", message: stopped });
      expect(forwarded.at(-1)?.message).toMatchObject(stopped);
      const reconnect = await runtime.snapshot();
      expect(reconnect.runState).toBe(runState);
      expect(reconnect.active?.transcriptPage.messages.at(-1)).toMatchObject(
        stopped,
      );

      await appendFile(path, jsonl(messageEntry("stopped", "u1", stopped)));
      worker.emit("event", { type: "agent_settled" });
      await vi.waitFor(async () => {
        const snapshot = await runtime.snapshot();
        expect(snapshot.runState).toBe(runState);
        const stoppedMessages = snapshot.active?.transcriptPage.messages.filter(
          (value) =>
            (value as { stopReason?: string }).stopReason === stopReason,
        );
        expect(stoppedMessages).toMatchObject([
          { ...stopped, __inspireEntryId: "stopped" },
        ]);
      });
    },
  );

  it("preserves ordered Pi deltas and distinct identities for assistants sharing a timestamp", async () => {
    const { runtime, workers } = await setup();
    const worker = workers[0]!;
    const forwarded: Record<string, unknown>[] = [];
    runtime.on("event", (event) => {
      if (String(event.type).startsWith("message_")) forwarded.push(event);
    });
    const first = { role: "assistant", content: [], timestamp: 20 };
    const content = [
      { type: "thinking", thinking: "live thought" },
      { type: "text", text: "live answer" },
    ];
    worker.emit("event", { type: "message_start", message: first });
    for (const assistantMessageEvent of [
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "live thought" },
      { type: "text_start", contentIndex: 1 },
      { type: "text_delta", contentIndex: 1, delta: "live answer" },
    ]) {
      worker.emit("event", { type: "message_update", assistantMessageEvent });
    }
    const [start, ...updates] = forwarded;
    const firstId = (start!.message as Record<string, unknown>).__inspireLiveId;
    expect(firstId).toEqual(expect.any(String));
    expect(updates).toMatchObject(
      [0, 12, 12, 23].map((streamTextLength, index) => ({
        streamDelta: true,
        streamMessageKey: `live:${firstId}`,
        streamTextLength,
        streamRevision: index + 1,
      })),
    );
    expect(
      (await runtime.snapshot()).active?.transcriptPage.messages.at(-1),
    ).toMatchObject({
      __inspireLiveId: firstId,
      __inspireStreamRevision: 4,
      content,
    });

    const second = { ...first, content: "next answer" };
    worker.emit("event", {
      type: "message_end",
      message: { ...first, content },
    });
    worker.emit("event", { type: "message_start", message: second });
    worker.emit("event", { type: "message_end", message: second });
    const [firstEnd, secondStart, secondEnd] = forwarded.slice(-3);
    expect(firstEnd!.message).toMatchObject({
      __inspireLiveId: firstId,
      content,
    });
    const secondId = (secondStart!.message as Record<string, unknown>)
      .__inspireLiveId;
    expect(secondId).toEqual(expect.any(String));
    expect(secondId).not.toBe(firstId);
    expect(secondEnd!.message).toMatchObject({ __inspireLiveId: secondId });

    const active = (await runtime.snapshot()).active!;
    expect(active.activeAssistantMessageKey).toBe(`live:${secondId}`);
    expect(active.transcriptPage.messages.slice(1)).toMatchObject([
      { __inspireLiveId: firstId, content },
      { __inspireLiveId: secondId, content: second.content },
    ]);
  });

  it("keeps equal-timestamp tool-result overlay messages distinct and reconciles both", async () => {
    const { runtime, workers, path } = await setup();
    workers[0]!.emit("event", { type: "agent_start" });
    const first = {
      role: "toolResult",
      content: "one",
      timestamp: 2,
      toolCallId: "call-1",
      toolName: "read",
    };
    const second = {
      role: "toolResult",
      content: "two",
      timestamp: 2,
      toolCallId: "call-2",
      toolName: "read",
    };
    for (const value of [first, second]) {
      workers[0]!.emit("event", { type: "message_start", message: value });
      workers[0]!.emit("event", { type: "message_end", message: value });
    }
    let snapshot = await runtime.snapshot();
    expect(
      snapshot.active?.transcriptPage.messages.filter(
        (value) => (value as { role?: string }).role === "toolResult",
      ),
    ).toHaveLength(2);
    await appendFile(
      path,
      jsonl(
        messageEntry("tr1", "u1", first),
        messageEntry("tr2", "tr1", second, "1970-01-01T00:00:00.003Z"),
      ),
    );
    workers[0]!.emit("event", { type: "agent_settled" });
    await vi.waitFor(async () => {
      snapshot = await runtime.snapshot();
      expect(snapshot.runState).toBe("idle");
    });
    expect(
      snapshot.active?.transcriptPage.messages.filter(
        (value) => (value as { role?: string }).role === "toolResult",
      ),
    ).toHaveLength(2);
  });

  it("matches repeated live custom messages to distinct saved entries with different timestamps", async () => {
    const { runtime, workers, path } = await setup();
    const customMessages = (
      snapshot: Awaited<ReturnType<typeof runtime.snapshot>>,
    ) =>
      snapshot.active!.transcriptPage.messages.filter(
        (message) => (message as { role?: string }).role === "custom",
      );
    const worker = workers[0]!;
    const payload = {
      customType: "relay_message",
      content: "same payload",
      display: true,
      details: { source: "peer" },
    };
    const live = { role: "custom", timestamp: 2_001, ...payload };
    worker.emit("event", { type: "agent_start" });
    for (let repeat = 0; repeat < 2; repeat++) {
      worker.emit("event", {
        type: "message_start",
        message: structuredClone(live),
      });
      worker.emit("event", {
        type: "message_end",
        message: structuredClone(live),
      });
    }
    const liveIds = customMessages(await runtime.snapshot()).map(
      (message) => (message as { __inspireLiveId?: string }).__inspireLiveId,
    );
    expect(liveIds).toEqual([expect.any(String), expect.any(String)]);
    expect(liveIds[0]).not.toBe(liveIds[1]);

    const entries = [
      {
        id: "custom-1",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:07.000Z",
      },
      {
        id: "custom-2",
        parentId: "custom-1",
        timestamp: "2026-08-01T00:00:08.000Z",
      },
    ];
    await appendFile(
      path,
      jsonl(
        ...entries.map((entry) => ({
          type: "custom_message",
          ...entry,
          ...payload,
        })),
      ),
    );
    worker.emit("event", { type: "agent_settled" });
    const saved = await vi.waitFor(async () => {
      const snapshot = await runtime.snapshot();
      expect(snapshot.runState).toBe("idle");
      const messages = customMessages(snapshot);
      expect(messages).toMatchObject(
        entries.map((entry) => ({
          __inspireEntryId: entry.id,
          __inspireMessageId: expect.any(String),
          timestamp: Date.parse(entry.timestamp),
          ...payload,
        })),
      );
      return messages;
    });
    for (const message of saved)
      expect(message).not.toHaveProperty("__inspireLiveId");
  });

  it("merges entry-first custom lifecycle events into the already projected row", async () => {
    const { runtime, workers, path } = await setup();
    const entry = {
      type: "custom_message",
      id: "custom-entry-first",
      parentId: "u1",
      timestamp: "2026-08-01T00:00:06.000Z",
      customType: "relay_message",
      content: "arrived while idle",
      display: true,
    };
    const live = {
      role: "custom",
      customType: "relay_message",
      content: "arrived while idle",
      display: true,
      timestamp: 3_000,
    };
    const worker = workers[0]!;
    worker.emit("event", {
      type: "entry_appended",
      entry: structuredClone(entry),
    });
    await appendFile(path, jsonl(entry));
    await vi.waitFor(async () => {
      expect(
        (await runtime.snapshot()).active?.transcriptPage.messages.some(
          (message) =>
            (message as Record<string, unknown>).__inspireMessageId ===
            "custom-entry-first:0",
        ),
      ).toBe(true);
    });

    const forwarded: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => {
      const record = event as Record<string, unknown>;
      if (record.type === "message_start" || record.type === "message_end")
        forwarded.push(record);
    });
    worker.emit("event", {
      type: "message_start",
      message: structuredClone(live),
    });
    worker.emit("event", {
      type: "message_end",
      message: structuredClone(live),
    });
    const snapshot = await runtime.snapshot();
    const custom =
      snapshot.active?.transcriptPage.messages.filter(
        (message) => (message as { role?: string }).role === "custom",
      ) ?? [];
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({
      timestamp: Date.parse(entry.timestamp),
      __inspireMessageId: "custom-entry-first:0",
      __inspireEntryId: "custom-entry-first",
    });
    expect(forwarded).toHaveLength(2);
    const forwardedMessages = forwarded.map(
      (event) => event.message as Record<string, unknown>,
    );
    expect(
      new Set(forwardedMessages.map((message) => message.__inspireLiveId)),
    ).toHaveLength(1);
    for (const message of forwardedMessages) {
      expect(message).toMatchObject({
        __inspireMessageId: "custom-entry-first:0",
        __inspireEntryId: "custom-entry-first",
      });
    }
    expect(forwardedMessages[1]).toMatchObject({ __inspireSettled: true });

    // The entry-first lifecycle must not leave a stale custom persistence
    // expectation that claims the next unrelated append.
    const assistant = {
      role: "assistant",
      content: "next",
      timestamp: 4_000,
      stopReason: "stop",
    };
    worker.emit("event", { type: "agent_start" });
    worker.emit("event", {
      type: "message_end",
      message: structuredClone(assistant),
    });
    await appendFile(
      path,
      jsonl(messageEntry("after-entry-first", "custom-entry-first", assistant)),
    );
    worker.emit("event", { type: "agent_settled" });
    await vi.waitFor(async () => {
      const settled = await runtime.snapshot();
      expect(settled.active?.projectionConflict).toBeNull();
      expect(
        settled.active?.transcriptPage.messages.some(
          (message) =>
            (message as Record<string, unknown>).__inspireMessageId ===
            "after-entry-first:0",
        ),
      ).toBe(true);
    });
  });

  it("bounds a live reply on reconnect and serves its complete saved text only for the current view", async () => {
    const { runtime, workers, path } = await setup();
    const text = `${"streaming".repeat(80_000)}THE_END_42\n`;
    const live = {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: 2,
    };
    workers[0]!.emit("event", { type: "agent_start" });
    workers[0]!.emit("event", { type: "message_start", message: live });
    let snapshot = await runtime.snapshot();
    expect(
      snapshot.active?.transcriptPage.messages.filter(
        (message) => (message as { timestamp?: number }).timestamp === 2,
      ),
    ).toHaveLength(1);
    expect(
      Buffer.byteLength(JSON.stringify(snapshot.active?.transcriptPage)),
    ).toBeLessThanOrEqual(TRANSCRIPT_PAGE_MAX_BYTES);
    expect(
      Buffer.byteLength(
        JSON.stringify(snapshot.active?.transcriptPage.messages),
      ),
    ).toBeLessThanOrEqual(TRANSIENT_OVERLAY_MAX_BYTES);

    await appendFile(path, jsonl(messageEntry("a1", "u1", live)));
    workers[0]!.emit("event", { type: "message_end", message: live });
    await vi.waitFor(async () => {
      snapshot = await runtime.snapshot();
      expect(snapshot.active?.activeAssistantMessageKey).toBe("persisted:a1:0");
    });
    workers[0]!.emit("event", { type: "agent_settled" });
    await vi.waitFor(async () => {
      snapshot = await runtime.snapshot();
      expect(snapshot.runState).toBe("idle");
    });
    const page = snapshot.active!.transcriptPage;
    expect(
      page.messages.filter(
        (message) => (message as { timestamp?: number }).timestamp === 2,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(page.messages)).not.toContain("THE_END_42");
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(
      3 * TRANSCRIPT_PAGE_MAX_BYTES,
    );
    expect(
      workers[0]!.commands.some((command) => command.type === "get_messages"),
    ).toBe(false);
    expect(await runtime.lastAssistantText("session-a", page.viewId)).toEqual({
      text,
    });
    expect(workers).toHaveLength(1);
    await expect(
      runtime.lastAssistantText("session-a", "stale-view"),
    ).rejects.toMatchObject({ status: 409 });
  });
});
