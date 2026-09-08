import { describe, expect, it, vi } from "vitest";
import { compactToolArgumentEvents } from "../../server/tool-argument-batches.js";
import { applyAssistantMessageDelta } from "../../shared/assistant-stream.js";
import type { DiagnosticLogger } from "../../server/diagnostics.js";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeEventController } from "../../server/runtime-events.js";
import { RuntimePersistenceOwnershipController } from "../../server/runtime-persistence-ownership.js";
import { createRuntimeSlot } from "../../server/runtime-slot.js";
import {
  boundedTranscriptProjection,
  TRANSCRIPT_ITEM_MAX_BYTES,
  TRANSIENT_OVERLAY_MAX_BYTES,
} from "../../server/session-projection.js";

function setup(incremental = true) {
  const rpc = {} as PiRpcProcess;
  const slot = createRuntimeSlot({
    id: "stream-test",
    cwd: "/tmp",
    sessionPath: null,
    process: rpc,
    preview: null,
    projection: null,
    bridge: null,
    branchRevision: 0,
    incarnationId: "incarnation",
    viewId: "view",
  });
  slot.ready = true;
  const ownership = new RuntimePersistenceOwnershipController(
    { readNewSessionEntries: async () => [] },
    {} as DiagnosticLogger,
  );
  let forwarded: Record<string, unknown> = {};
  const forwardedEvents: Record<string, unknown>[] = [];
  const events = new RuntimeEventController({
    selectedSessionId: () => slot.id,
    recordPersistenceEvent: () => {},
    activeAssistantOverlayMessage: (owner) =>
      ownership.activeAssistantOverlayMessage(owner),
    updateOverlay: (owner, message, phase, delta) =>
      ownership.updateOverlay(
        owner,
        message,
        phase,
        incremental ? delta : undefined,
      ),
    addPendingExtensionUi: () => null,
    clearPendingExtensionUi: () => {},
    invalidateCatalog: () => {},
    scheduleIdleWorkerEviction: () => {},
    emitSlotEvent: (_owner, event) => {
      forwarded = event as Record<string, unknown>;
      forwardedEvents.push(forwarded);
    },
    processOwner: () => slot,
    reconcileSlot: async () => {},
    setProjectionConflict: () => {
      throw new Error("Unexpected conflict");
    },
    stopWriter: async () => {},
    logRuntimeError: () => {},
    safeProjection: (value) => value,
  });
  const emit = (event: unknown) => events.dispatchProcessEvent(rpc, event);
  const start = (content: unknown[] = []) =>
    emit({
      type: "message_start",
      message: { role: "assistant", timestamp: 20, content },
    });
  const delta = (type: string, contentIndex: number, value: unknown) =>
    emit({
      type: "message_update",
      assistantMessageEvent: { type, contentIndex, delta: value },
    });
  return {
    slot,
    emit,
    start,
    delta,
    forwarded: () => forwarded,
    forwardedEvents,
  };
}

function expectExactBudget(slot: ReturnType<typeof setup>["slot"]) {
  expect(slot.overlayItemBytes).toEqual(
    slot.overlay.map((item) => Buffer.byteLength(JSON.stringify(item))),
  );
  expect(slot.overlayBytes).toBe(
    Buffer.byteLength(JSON.stringify(slot.overlay)),
  );
  expect(slot.overlayBytes).toBeLessThanOrEqual(TRANSIENT_OVERLAY_MAX_BYTES);
}

function measureWork(events: number, incremental: boolean) {
  const fixture = setup(incremental);
  fixture.start([
    { type: "text", text: "" },
    { type: "thinking", thinking: "" },
  ]);
  const stringify = JSON.stringify;
  let fullMessages = 0;
  let bytes = 0;
  const spy = vi
    .spyOn(JSON, "stringify")
    .mockImplementation((value, replacer, space) => {
      const encoded = stringify(value, replacer, space);
      if (value?.role === "assistant") fullMessages++;
      bytes += Buffer.byteLength(encoded ?? "null");
      return encoded;
    });
  try {
    for (let index = 0; index < events; index++) {
      fixture.delta(
        index % 2 ? "thinking_delta" : "text_delta",
        index % 2,
        "x".repeat(32),
      );
    }
  } finally {
    spy.mockRestore();
  }
  expectExactBudget(fixture.slot);
  return { events, fullMessages, bytes, message: fixture.slot.overlay.at(-1) };
}

describe("runtime assistant stream byte budget", () => {
  it("serializes only appended fragments, with linear work across valid event counts", () => {
    const rows = [1000, 2000].map((count) => {
      const baseline = measureWork(count, false);
      const incremental = measureWork(count, true);
      expect(incremental.message).toEqual(baseline.message);
      expect(baseline.fullMessages).toBe(count);
      expect(incremental.fullMessages).toBe(0);
      expect(incremental.bytes).toBe(count * 34);
      return {
        events: count,
        baselineBytes: baseline.bytes,
        incrementalBytes: incremental.bytes,
        baselineFullMessages: baseline.fullMessages,
        incrementalFullMessages: incremental.fullMessages,
      };
    });
    console.info(
      "Host overlay JSON serialization work (not transport/latency):",
      rows,
    );
  });

  it("counts escaping, Unicode, split surrogates, revisions, and the 64k cap exactly", () => {
    const fixture = setup();
    fixture.start([
      { type: "text", text: "" },
      { type: "thinking", thinking: "" },
    ]);
    for (let index = 0; index < 110; index++) {
      for (const fragment of ['"\\\n\t\u0000', "中文😀", "\ud83d", "\ude00"]) {
        fixture.delta("text_delta", 0, fragment);
        fixture.delta("thinking_delta", 1, fragment);
        expectExactBudget(fixture.slot);
      }
    }
    fixture.delta("text_delta", 0, "z".repeat(70_000));
    const message = fixture.slot.overlay.at(-1) as {
      content: { text: string }[];
    };
    expect(message.content[0]!.text).toHaveLength(64_000);
    expectExactBudget(fixture.slot);
    const before = fixture.slot.overlay.at(-1);
    fixture.delta("text_delta", 0, "ignored beyond cap");
    expect(fixture.slot.overlay.at(-1)).toBe(before);
  });

  it("retains full fallback for malformed, structural, complete, and final messages", () => {
    const fast = setup();
    const full = setup(false);
    for (const fixture of [fast, full])
      fixture.start([{ type: "text", text: "seed" }]);
    const updates = [
      { type: "text_delta", contentIndex: -1, delta: "invalid" },
      { type: "text_delta", contentIndex: 0, delta: 42 },
      { type: "thinking_delta", contentIndex: 1, delta: 42 },
      { type: "thinking_delta", contentIndex: 1, delta: "valid" },
      { type: "text_end", contentIndex: 0, content: "replacement" },
      {
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: {
          type: "toolCall",
          id: "tool",
          name: "test",
          arguments: { apiKey: "private", text: "x".repeat(70_000) },
        },
      },
    ];
    for (const assistantMessageEvent of updates) {
      for (const fixture of [fast, full])
        fixture.emit({ type: "message_update", assistantMessageEvent });
      expect(fast.slot.overlay).toEqual(full.slot.overlay);
      expect(fast.forwarded()).toEqual(full.forwarded());
      expectExactBudget(fast.slot);
    }
    for (const type of ["message_update", "message_end"]) {
      for (const fixture of [fast, full])
        fixture.emit({
          type,
          message: {
            role: "assistant",
            timestamp: 20,
            apiKey: "private",
            content: [{ type: "text", text: "final".repeat(20_000) }],
          },
        });
      expect(fast.slot.overlay).toEqual(full.slot.overlay);
      expect(JSON.stringify(fast.slot.overlay)).not.toContain("private");
      expectExactBudget(fast.slot);
    }
    expect(fast.slot.overlay.at(-1)).toHaveProperty("__inspireSettled", true);
  });

  it("falls back at the item byte ceiling and preserves snapshot validation", () => {
    const fast = setup();
    const full = setup(false);
    // Three strings fit independently but escaped growth crosses the item limit.
    for (const fixture of [fast, full])
      fixture.start([
        { type: "text", text: "x".repeat(64_000) },
        { type: "thinking", thinking: "x".repeat(64_000) },
        { type: "text", text: "x".repeat(64_000) },
        { type: "thinking", thinking: "" },
      ]);
    for (let index = 0; index < 15; index++) {
      for (const fixture of [fast, full])
        fixture.delta("thinking_delta", 3, "\u0000".repeat(1000));
      expect(fast.slot.overlay).toEqual(full.slot.overlay);
      expectExactBudget(fast.slot);
      expect(fast.slot.overlayItemBytes[0]).toBeLessThanOrEqual(
        TRANSCRIPT_ITEM_MAX_BYTES,
      );
    }
    // Snapshot projection still independently validates the complete value.
    expect(boundedTranscriptProjection(fast.slot.overlay[0]).value).toEqual(
      fast.slot.overlay[0],
    );
  });

  it("evicts oldest overlay items when an incremental delta crosses the total budget", () => {
    const fast = setup();
    const full = setup(false);
    for (const fixture of [fast, full]) {
      for (let index = 0; index < 3; index++) {
        fixture.start([
          { type: "text", text: "x".repeat(64_000) },
          { type: "thinking", thinking: "x".repeat(64_000) },
          { type: "text", text: "x".repeat(10_000) },
        ]);
      }
      fixture.start([
        { type: "text", text: "x".repeat(60_000) },
        { type: "thinking", thinking: "" },
      ]);
      expect(fixture.slot.overlay).toHaveLength(4);
      fixture.delta("thinking_delta", 1, "x".repeat(60_000));
    }
    expect(fast.slot.overlay).toEqual(full.slot.overlay);
    expect(fast.slot.overlay).toHaveLength(3);
    expectExactBudget(fast.slot);
  });
});

function startTool(
  fixture: ReturnType<typeof setup>,
  index = 0,
  name = "write",
) {
  fixture.emit({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: index,
      id: `call-${index}`,
      toolName: name,
    },
  });
}

describe("runtime tool argument streaming", () => {
  it("creates an early typed shell and keeps browser deltas and reconnect snapshots identical", () => {
    const fixture = setup();
    fixture.start();
    startTool(fixture);
    expect(fixture.slot.overlay.at(-1)).toMatchObject({
      content: [
        {
          type: "toolCall",
          id: "call-0",
          name: "write",
          arguments: {},
          __inspireToolCall: { phase: "streaming" },
        },
      ],
    });
    const snapshot = fixture.slot.overlay.at(-1);
    let reconstructed: unknown = snapshot;
    const offset = fixture.forwardedEvents.length;
    for (const fragment of [
      '{"path":"src/file.ts","content":"one',
      "\\n",
      "two",
      "\\uD83D",
      "\\uDE00",
      '","apiKey":"NEVER-SEND"}',
    ]) {
      fixture.delta("toolcall_delta", 0, fragment);
      expectExactBudget(fixture.slot);
    }
    const frames = fixture.forwardedEvents.slice(offset);
    expect(JSON.stringify(frames)).not.toContain("NEVER-SEND");
    const last = frames.at(-1)!;
    const compact = compactToolArgumentEvents(
      frames.map((frame) => frame.assistantMessageEvent),
    );
    for (const delta of compact)
      reconstructed = applyAssistantMessageDelta(reconstructed, delta);
    reconstructed = {
      ...(reconstructed as Record<string, unknown>),
      __inspireStreamRevision: last.streamRevision,
    };
    expect(reconstructed).toEqual(fixture.slot.overlay.at(-1));
    expect(compact).toHaveLength(1);
    expect(reconstructed).toMatchObject({
      content: [
        {
          arguments: {
            path: "src/file.ts",
            content: "one\ntwo😀",
            apiKey: "[redacted]",
          },
        },
      ],
    });
    expect(snapshot).toMatchObject({ content: [{ arguments: {} }] });
  });

  it("does not reset a live tool parser for interleaved extension messages or a second call", () => {
    const fixture = setup();
    fixture.start();
    startTool(fixture);
    fixture.delta("toolcall_delta", 0, '{"content":"first');
    fixture.emit({
      type: "message_start",
      message: { role: "custom", content: "extension", timestamp: 21 },
    });
    fixture.emit({
      type: "message_end",
      message: { role: "custom", content: "extension", timestamp: 21 },
    });
    startTool(fixture, 1, "bash");
    fixture.delta("toolcall_delta", 1, '{"command":"echo hello"}');
    fixture.delta("toolcall_delta", 0, ' second"}');
    expect(
      fixture.slot.overlay.find((value: any) => value.role === "assistant"),
    ).toMatchObject({
      content: [
        { id: "call-0", arguments: { content: "first second" } },
        { id: "call-1", arguments: { command: "echo hello" } },
      ],
    });
    expectExactBudget(fixture.slot);
  });

  it("ends authoritatively, bounds and redacts the terminal call once, and marks aborted arguments as unexecuted", () => {
    const fixture = setup();
    fixture.start();
    startTool(fixture);
    fixture.delta("toolcall_delta", 0, '{"content":"preview');
    const toolCall = {
      type: "toolCall",
      id: "call-0",
      name: "write",
      arguments: { content: "x".repeat(70_000), token: "NEVER-SEND" },
    };
    fixture.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall,
      },
    });
    expect(fixture.forwarded()).not.toHaveProperty("assistantMessageEvent");
    expect(JSON.stringify(fixture.forwarded())).not.toContain("NEVER-SEND");
    expect(fixture.slot.overlay.at(-1)).toMatchObject({
      content: [{ arguments: { token: "[redacted]" } }],
    });
    expect((fixture.slot.overlay.at(-1) as any).content[0]).not.toHaveProperty(
      "__inspireToolCall",
    );
    const previous = fixture.forwarded();
    fixture.delta("toolcall_delta", 0, "ignored late delta");
    expect(fixture.forwarded()).toBe(previous);
    fixture.start();
    startTool(fixture);
    fixture.delta("toolcall_delta", 0, '{"content":"unfinished');
    fixture.emit({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 20,
        stopReason: "aborted",
        content: [
          {
            type: "toolCall",
            id: "call-0",
            name: "write",
            arguments: { content: "unfinished" },
          },
        ],
      },
    });
    expect(fixture.slot.overlay.at(-1)).toMatchObject({
      content: [{ __inspireToolCall: { phase: "interrupted" } }],
    });
    expectExactBudget(fixture.slot);
  });

  it("publishes a complete replacement when the item budget clips an argument tree", () => {
    const fixture = setup();
    fixture.start(
      Array.from({ length: 3 }, () => ({
        type: "text",
        text: "x".repeat(64_000),
      })),
    );
    startTool(fixture, 3);
    fixture.delta("toolcall_delta", 3, '{"content":"');
    fixture.delta("toolcall_delta", 3, "\\u0000".repeat(16_000));
    const frame = fixture.forwarded();
    expect(frame.message).toHaveProperty("__inspireProjectionReduced", true);
    expect(frame).not.toHaveProperty("streamDelta");
    expect(frame).not.toHaveProperty("assistantMessageEvent");
    expect(frame.message).toEqual(fixture.slot.overlay.at(-1));
    expectExactBudget(fixture.slot);
  });

  it("serializes append fragments rather than cumulative bodies, including split-surrogate JSON growth", () => {
    const measurements = [1000, 2000].map((count) => {
      const fixture = setup();
      fixture.start();
      startTool(fixture);
      fixture.delta("toolcall_delta", 0, '{"content":"');
      const stringify = JSON.stringify;
      let fullMessages = 0;
      let bytes = 0;
      const spy = vi
        .spyOn(JSON, "stringify")
        .mockImplementation((value, replacer, space) => {
          const encoded = stringify(value, replacer, space);
          if (value?.role === "assistant") fullMessages++;
          bytes += Buffer.byteLength(encoded ?? "null");
          return encoded;
        });
      try {
        for (let n = 0; n < count; n++)
          fixture.delta("toolcall_delta", 0, "abcdefgh");
      } finally {
        spy.mockRestore();
      }
      expect(fullMessages).toBe(0);
      expect(bytes).toBe(count * 10);
      for (const delta of [
        "\\uD83D",
        "\\uDE00",
        "\\n",
        "\\u0000",
        '\\"',
        "\\\\",
        "中文",
      ]) {
        fixture.delta("toolcall_delta", 0, delta);
        expectExactBudget(fixture.slot);
      }
      fixture.delta("toolcall_delta", 0, "x".repeat(40_000));
      expectExactBudget(fixture.slot);
      expect(fixture.slot.overlay.at(-1)).toMatchObject({
        content: [{ __inspireToolCall: { truncated: true } }],
      });
      const capped = fixture.forwarded();
      fixture.delta("toolcall_delta", 0, "x".repeat(1_000_000));
      expect(fixture.forwarded()).toBe(capped);
      return { fragments: count, serializedAppendBytes: bytes, fullMessages };
    });
    console.info("Host tool-argument serialization work:", measurements);
  });
});
