import { appendFile } from "node:fs/promises";
import { TaskOutcomeTracker } from "../../server/task-notifications.js";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TRANSCRIPT_PAGE_MAX_BYTES,
  TRANSIENT_OVERLAY_MAX_BYTES,
} from "../../server/session-projection.js";

import {
  disposeProjectionFixture,
  setup,
} from "./fixtures/runtime-projection.js";

afterEach(disposeProjectionFixture);

describe("live and durable transcript reconciliation", () => {
  it.each([false, true])(
    "uses native cancellation evidence for failure attention and notifications (aborted=%s)",
    async (aborted) => {
      const { runtime, workers } = await setup();
      const tracker = new TaskOutcomeTracker();
      const notifications: unknown[] = [];
      const events: Array<Record<string, unknown>> = [];
      runtime.on("event", (event) => {
        events.push(event);
        const notification = tracker.observe(event);
        if (notification) notifications.push(notification);
      });
      try {
        await runtime.deselectSession();
        const worker = workers[0]!;
        worker.emit("event", { type: "agent_start" });
        worker.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "This operation was aborted",
            timestamp: 2,
          },
        });
        worker.emit("event", { type: "agent_settled", aborted });
        await vi.waitFor(() =>
          expect(
            events.findLast((event) => event.type === "agent_settled"),
          ).toMatchObject({
            sessionStatus: { runState: aborted ? "aborted" : "failed" },
          }),
        );
        expect(notifications).toEqual(
          aborted ? [] : [expect.objectContaining({ outcome: "failed" })],
        );
      } finally {
        await runtime.close();
      }
    },
  );
  it.each(["retry", "completed message"])(
    "settles a background %s cancellation without completion/failure attention",
    async (phase) => {
      const { runtime, workers } = await setup();
      try {
        const events: Array<Record<string, unknown>> = [];
        runtime.on("event", (event) => events.push(event));
        await runtime.deselectSession();
        const emit = (event: Record<string, unknown>) =>
          workers[0]!.emit("event", event);
        emit({ type: "agent_start" });
        emit(
          phase === "retry"
            ? {
                type: "auto_retry_end",
                success: false,
                finalError: "Retry cancelled",
              }
            : {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: "finished",
                  stopReason: "stop",
                  timestamp: 2,
                },
              },
        );
        emit({ type: "agent_settled", aborted: true });
        await vi.waitFor(() =>
          expect(
            events.findLast((event) => event.type === "agent_settled"),
          ).toMatchObject({
            sessionStatus: { runState: "aborted" },
          }),
        );
        const settled = events.findLast(
          (event) => event.type === "agent_settled",
        )!;
        expect(settled.sessionStatus).not.toHaveProperty("indicator");
        expect((await runtime.snapshot("session-a")).runState).toBe("aborted");
      } finally {
        await runtime.close();
      }
    },
  );

  it.each(["character", "line"] as const)(
    "keeps the latest output beyond general projection (%s bound)",
    async (bound) => {
      const { runtime, workers } = await setup();
      const events: Array<Record<string, unknown>> = [];
      runtime.on("event", (event) => events.push(event));
      try {
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
        expect(
          tool!.outputPreview!.text.split("\n").length,
        ).toBeLessThanOrEqual(400);
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
      } finally {
        await runtime.close();
      }
    },
  );

  it("bounds Codemode's own snapshot before transport without duplicating generic receipts", async () => {
    const { runtime, workers } = await setup();
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event));
    try {
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
              cost: 10,
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
        partialResult: { details: {} },
      });
      expect((event.childCalls as { calls: unknown[] }).calls).toHaveLength(
        256,
      );
      expect(JSON.stringify(event)).not.toContain('"cost"');
      const tool = (await runtime.snapshot()).active?.toolActivity?.script;
      expect(tool?.calls?.calls).toHaveLength(256);
      expect(tool?.calls?.calls[0]?.key).toBe("codemode:0");
      expect(
        Object.keys((await runtime.snapshot()).active?.toolActivity ?? {}),
      ).toEqual(["script"]);
    } finally {
      await runtime.close();
    }
  });

  it("restores bounded parented receipts on reconnect without retaining child results", async () => {
    const { runtime, workers } = await setup();
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event));
    const emit = (event: Record<string, unknown>) =>
      workers[0]!.emit("event", event);
    try {
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
      expect(JSON.stringify(events)).not.toContain("rawResult");
      expect(JSON.stringify(tools)).not.toContain("secret");
      emit({
        type: "tool_execution_end",
        toolCallId: "parent",
        toolName: "orchestrator",
        result: { content: [{ type: "text", text: "Parent succeeded" }] },
        isError: false,
      });
      expect(
        (await runtime.snapshot()).active?.toolActivity?.parent?.phase,
      ).toBe("done");
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
    } finally {
      await runtime.close();
    }
  });

  it("reads unbounded settled text from the real JSONL branch and rejects stale views", async () => {
    const text = `${"x".repeat(70_000)}THE_END_42\n`;
    const { runtime, workers } = await setup([
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          timestamp: 2,
        },
      },
    ]);
    try {
      const snapshot = await runtime.snapshot();
      const page = snapshot.active!.transcriptPage;
      expect(JSON.stringify(page.messages)).not.toContain("THE_END_42");
      const count = workers.length;
      expect(await runtime.lastAssistantText("session-a", page.viewId)).toEqual(
        { text },
      );
      expect(workers).toHaveLength(count);
      await expect(
        runtime.lastAssistantText("session-a", "stale-view"),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await runtime.close();
    }
  });

  it("keeps a greater-than-10-MiB active history bounded without get_messages", async () => {
    const extra: unknown[] = [];
    let parent = "u1";
    for (let index = 0; index < 24; index += 1) {
      const id = `large-${index}`;
      extra.push({
        type: "message",
        id,
        parentId: parent,
        timestamp: new Date(index + 2).toISOString(),
        message: {
          role: index % 2 ? "assistant" : "user",
          content: "x".repeat(480_000),
          timestamp: index + 2,
        },
      });
      parent = id;
    }
    const { runtime, workers } = await setup(extra);
    try {
      const snapshot = await runtime.snapshot();
      expect(
        snapshot.active?.transcriptPage.messages.length,
      ).toBeLessThanOrEqual(100);
      expect(
        Buffer.byteLength(JSON.stringify(snapshot.active?.transcriptPage)),
      ).toBeLessThanOrEqual(TRANSCRIPT_PAGE_MAX_BYTES);
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(
        3 * TRANSCRIPT_PAGE_MAX_BYTES,
      );
      expect(
        workers
          .flatMap((worker) => worker.commands)
          .some((command) => command.type === "get_messages"),
      ).toBe(false);
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it.each([
    { content: [] },
    { content: [{ type: "text", text: "partial output" }] },
    {
      content: [
        {
          type: "toolCall",
          id: "interrupted-write",
          name: "write",
          arguments: { path: "src/partial.ts", content: "unfinished" },
        },
      ],
    },
  ])(
    "preserves Pi failure details across live events, reconnect snapshots, and persistence (%j)",
    async ({ content }) => {
      const { runtime, workers, path } = await setup();
      try {
        const forwarded: Array<Record<string, unknown>> = [];
        runtime.on("event", (event) => {
          const record = event as Record<string, unknown>;
          if (record.type === "message_end") forwarded.push(record);
        });
        const live = { role: "assistant", content, timestamp: 2 };
        const failed = {
          ...live,
          stopReason: "error",
          errorMessage: "WebSocket error",
        };
        const worker = workers[0]!;
        worker.emit("event", { type: "agent_start" });
        worker.emit("event", { type: "message_start", message: live });
        worker.emit("event", { type: "message_end", message: failed });
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]!.message).toMatchObject(failed);
        const reconnect = await runtime.snapshot();
        expect(reconnect.runState).toBe("failed");
        expect(reconnect.active?.transcriptPage.messages.at(-1)).toMatchObject(
          failed,
        );
        await appendFile(
          path,
          `${JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z", message: failed })}\n`,
        );
        worker.emit("event", { type: "agent_settled" });
        await vi.waitFor(async () => {
          const snapshot = await runtime.snapshot();
          const errors = snapshot.active?.transcriptPage.messages.filter(
            (value) =>
              (value as { stopReason?: string }).stopReason === "error",
          );
          expect(errors).toHaveLength(1);
          expect(errors![0]).toMatchObject({
            ...failed,
            __inspireEntryId: "a1",
          });
        });
      } finally {
        await runtime.close();
      }
    },
  );

  it.each([
    ["aborted", "aborted"],
    ["error", "failed"],
  ])(
    "preserves native %s as %s across settlement, snapshot and persistence",
    async (stopReason, runState) => {
      const { runtime, workers, path } = await setup();
      try {
        const forwarded: Array<Record<string, unknown>> = [];
        runtime.on("event", (event) => {
          if (event.type === "message_end") forwarded.push(event);
        });
        const stopped = {
          role: "assistant",
          content: [],
          stopReason,
          errorMessage: "This operation was aborted",
          timestamp: 2,
        };
        workers[0]!.emit("event", { type: "agent_start" });
        workers[0]!.emit("event", {
          type: "message_start",
          message: {
            ...stopped,
            stopReason: undefined,
            errorMessage: undefined,
          },
        });
        workers[0]!.emit("event", { type: "message_end", message: stopped });
        expect(forwarded.at(-1)?.message).toMatchObject(stopped);
        expect((await runtime.snapshot()).runState).toBe(runState);
        await appendFile(
          path,
          `${JSON.stringify({ type: "message", id: "stopped", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z", message: stopped })}\n`,
        );
        workers[0]!.emit("event", { type: "agent_settled" });
        await vi.waitFor(async () => {
          const snapshot = await runtime.snapshot();
          expect(snapshot.runState).toBe(runState);
          expect(snapshot.active?.transcriptPage.messages.at(-1)).toMatchObject(
            { ...stopped, __inspireEntryId: "stopped" },
          );
        });
      } finally {
        await runtime.close();
      }
    },
  );

  it("forwards stable lifecycle IDs and keeps equal-timestamp ordinary assistant messages distinct", async () => {
    const { runtime, workers } = await setup();
    try {
      const forwarded: Array<Record<string, unknown>> = [];
      runtime.on("event", (event) => {
        const record = event as Record<string, unknown>;
        if (String(record.type).startsWith("message_")) forwarded.push(record);
      });
      const first = { role: "assistant", content: "first", timestamp: 2 };
      workers[0]!.emit("event", { type: "message_start", message: first });
      workers[0]!.emit("event", {
        type: "message_update",
        message: { ...first, content: "first update" },
      });
      workers[0]!.emit("event", {
        type: "message_end",
        message: { ...first, content: "first final" },
      });
      const second = { role: "assistant", content: "second", timestamp: 2 };
      workers[0]!.emit("event", { type: "message_start", message: second });
      workers[0]!.emit("event", { type: "message_end", message: second });

      const ids = forwarded.map((event) =>
        String((event.message as Record<string, unknown>).__inspireLiveId),
      );
      expect(new Set(ids.slice(0, 3)).size).toBe(1);
      expect(ids[3]).toBe(ids[4]);
      expect(ids[3]).not.toBe(ids[0]);
      const snapshot = await runtime.snapshot();
      expect(
        snapshot.active?.transcriptPage.messages.filter(
          (value) =>
            (value as { role?: string; timestamp?: number }).role ===
              "assistant" && (value as { timestamp?: number }).timestamp === 2,
        ),
      ).toHaveLength(2);
      expect(snapshot.active?.activeAssistantMessageKey).toBe(`live:${ids[3]}`);
    } finally {
      await runtime.close();
    }
  });

  it("reconstructs Pi 0.84 delta-only assistant updates in events and snapshots", async () => {
    const { runtime, workers } = await setup();
    try {
      const forwarded: Array<Record<string, unknown>> = [];
      runtime.on("event", (event) => {
        const record = event as Record<string, unknown>;
        if (record.type === "message_update") forwarded.push(record);
      });
      workers[0]!.emit("event", {
        type: "message_start",
        message: {
          role: "assistant",
          content: [],
          timestamp: 20,
          provider: "openai-codex",
          model: "gpt-5.6",
        },
      });
      workers[0]!.emit("event", {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
      });
      workers[0]!.emit("event", {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "live thought",
        },
      });
      workers[0]!.emit("event", {
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 1 },
      });
      workers[0]!.emit("event", {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: "live answer",
        },
      });
      // Legacy Pi <0.84.3 starts lacked identity/name; retain end-only support.
      workers[0]!.emit("event", {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 2,
        },
      });
      workers[0]!.emit("event", {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 2,
          delta: '{"path":',
        },
      });
      workers[0]!.emit("event", {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 2,
          toolCall: {
            type: "toolCall",
            id: "tool-1",
            name: "read",
            arguments: { path: "README.md" },
          },
        },
      });

      const snapshot = await runtime.snapshot();
      expect(forwarded).toHaveLength(5);
      expect(
        forwarded.slice(0, 4).every((event) => event.streamDelta === true),
      ).toBe(true);
      expect(forwarded.at(-1)).not.toHaveProperty("assistantMessageEvent");
      expect(forwarded.at(-1)).not.toHaveProperty("streamDelta");
      expect(
        new Set(forwarded.slice(0, 4).map((event) => event.streamMessageKey)),
      ).toHaveLength(1);
      expect(
        forwarded.slice(0, 4).map((event) => event.streamTextLength),
      ).toEqual([0, 12, 12, 23]);
      expect(forwarded.map((event) => event.streamRevision)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      const identities = forwarded.map(
        (event) => (event.message as Record<string, unknown>).__inspireLiveId,
      );
      expect(new Set(identities)).toHaveLength(1);
      expect(
        (forwarded.at(-1)!.message as Record<string, unknown>).content,
      ).toEqual([
        { type: "thinking", thinking: "live thought" },
        { type: "text", text: "live answer" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "read",
          arguments: { path: "README.md" },
        },
      ]);
      expect(snapshot.active?.transcriptPage.messages.at(-1)).toMatchObject({
        role: "assistant",
        __inspireStreamRevision: 5,
        content: [
          { type: "thinking", thinking: "live thought" },
          { type: "text", text: "live answer" },
          {
            type: "toolCall",
            id: "tool-1",
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
      });
    } finally {
      await runtime.close();
    }
  });

  it("keeps equal-timestamp tool-result overlay messages distinct and reconciles both", async () => {
    const { runtime, workers, path } = await setup();
    try {
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
        `${JSON.stringify({ type: "message", id: "tr1", parentId: "u1", timestamp: "2026-08-01T00:00:02.000Z", message: first })}\n${JSON.stringify({ type: "message", id: "tr2", parentId: "tr1", timestamp: "2026-08-01T00:00:03.000Z", message: second })}\n`,
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
    } finally {
      await runtime.close();
    }
  });

  it("pairs a live custom message to its durable entry despite Pi assigning a different persistence timestamp", async () => {
    const { runtime, workers, path } = await setup();
    try {
      const live = {
        role: "custom",
        customType: "intercom_message",
        content: "delivered",
        display: true,
        details: { source: "peer" },
        timestamp: 2_000,
      };
      const entry = {
        type: "custom_message",
        id: "custom-1",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:05.000Z",
        customType: "intercom_message",
        content: "delivered",
        display: true,
        details: { source: "peer" },
      };
      const worker = workers[0]!;
      worker.emit("event", { type: "agent_start" });
      worker.emit("event", {
        type: "message_start",
        message: structuredClone(live),
      });
      worker.emit("event", {
        type: "message_end",
        message: structuredClone(live),
      });
      const liveSnapshot = await runtime.snapshot();
      const liveCustom =
        liveSnapshot.active?.transcriptPage.messages.filter(
          (message) => (message as { role?: string }).role === "custom",
        ) ?? [];
      expect(liveCustom).toHaveLength(1);
      expect(
        (liveCustom[0] as Record<string, unknown>).__inspireLiveId,
      ).toMatch(/:live:/);

      await appendFile(path, `${JSON.stringify(entry)}\n`);
      worker.emit("event", { type: "agent_settled" });
      let snapshot = await runtime.snapshot();
      await vi.waitFor(async () => {
        snapshot = await runtime.snapshot();
        expect(snapshot.runState).toBe("idle");
        expect(
          snapshot.active?.transcriptPage.messages.some(
            (message) =>
              (message as Record<string, unknown>).__inspireMessageId ===
              "custom-1:0",
          ),
        ).toBe(true);
      });
      const custom =
        snapshot.active?.transcriptPage.messages.filter(
          (message) => (message as { role?: string }).role === "custom",
        ) ?? [];
      expect(custom).toHaveLength(1);
      expect(custom[0]).toMatchObject({
        timestamp: Date.parse(entry.timestamp),
        __inspireMessageId: "custom-1:0",
        __inspireEntryId: "custom-1",
      });
      expect(custom[0]).not.toHaveProperty("__inspireLiveId");
    } finally {
      await runtime.close();
    }
  });

  it("pairs equal-payload custom messages one-to-one without coalescing legitimate repeats", async () => {
    const { runtime, workers, path } = await setup();
    try {
      const worker = workers[0]!;
      worker.emit("event", { type: "agent_start" });
      for (const timestamp of [2_001, 2_001]) {
        const live = {
          role: "custom",
          customType: "intercom_message",
          content: "same payload",
          display: true,
          timestamp,
        };
        worker.emit("event", {
          type: "message_start",
          message: structuredClone(live),
        });
        worker.emit("event", {
          type: "message_end",
          message: structuredClone(live),
        });
      }
      const entries = [
        {
          type: "custom_message",
          id: "custom-repeat-1",
          parentId: "u1",
          timestamp: "2026-08-01T00:00:07.000Z",
          customType: "intercom_message",
          content: "same payload",
          display: true,
        },
        {
          type: "custom_message",
          id: "custom-repeat-2",
          parentId: "custom-repeat-1",
          timestamp: "2026-08-01T00:00:08.000Z",
          customType: "intercom_message",
          content: "same payload",
          display: true,
        },
      ];
      await appendFile(
        path,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      worker.emit("event", { type: "agent_settled" });
      let snapshot = await runtime.snapshot();
      await vi.waitFor(async () => {
        snapshot = await runtime.snapshot();
        expect(snapshot.runState).toBe("idle");
        expect(
          snapshot.active?.transcriptPage.messages.filter(
            (message) => (message as { role?: string }).role === "custom",
          ),
        ).toHaveLength(2);
      });
      expect(
        snapshot.active?.transcriptPage.messages
          .filter((message) => (message as { role?: string }).role === "custom")
          .map(
            (message) =>
              (message as Record<string, unknown>).__inspireMessageId,
          ),
      ).toEqual(["custom-repeat-1:0", "custom-repeat-2:0"]);
    } finally {
      await runtime.close();
    }
  });

  it("merges entry-first custom lifecycle events into the already projected row", async () => {
    const { runtime, workers, path } = await setup();
    try {
      const entry = {
        type: "custom_message",
        id: "custom-entry-first",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:06.000Z",
        customType: "intercom_message",
        content: "arrived while idle",
        display: true,
      };
      const live = {
        role: "custom",
        customType: "intercom_message",
        content: "arrived while idle",
        display: true,
        timestamp: 3_000,
      };
      const worker = workers[0]!;
      worker.emit("event", {
        type: "entry_appended",
        entry: structuredClone(entry),
      });
      await appendFile(path, `${JSON.stringify(entry)}\n`);
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
        `${JSON.stringify({
          type: "message",
          id: "after-entry-first",
          parentId: "custom-entry-first",
          timestamp: "2026-08-01T00:00:09.000Z",
          message: assistant,
        })}\n`,
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
    } finally {
      await runtime.close();
    }
  });

  it("uses a bounded live overlay for reconnect and removes it after persistence without duplicates", async () => {
    const { runtime, workers, path } = await setup();
    try {
      const live = {
        role: "assistant",
        content: [{ type: "text", text: "streaming".repeat(80_000) }],
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

      await appendFile(
        path,
        `${JSON.stringify({
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp: "2026-08-01T00:00:02.000Z",
          message: live,
        })}\n`,
      );
      workers[0]!.emit("event", { type: "message_end", message: live });
      await vi.waitFor(async () => {
        snapshot = await runtime.snapshot();
        expect(snapshot.active?.activeAssistantMessageKey).toBe(
          "persisted:a1:0",
        );
      });
      workers[0]!.emit("event", { type: "agent_settled" });
      await vi.waitFor(async () => {
        snapshot = await runtime.snapshot();
        expect(snapshot.runState).toBe("idle");
      });
      expect(
        snapshot.active?.transcriptPage.messages.filter(
          (message) => (message as { timestamp?: number }).timestamp === 2,
        ),
      ).toHaveLength(1);
      expect(
        workers[0]!.commands.some((command) => command.type === "get_messages"),
      ).toBe(false);
    } finally {
      await runtime.close();
    }
  });
});
