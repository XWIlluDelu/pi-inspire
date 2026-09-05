import { describe, expect, it, vi } from "vitest";
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
  return { slot, emit, start, delta, forwarded: () => forwarded };
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
