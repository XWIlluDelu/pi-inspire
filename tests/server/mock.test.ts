import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRuntime } from "../../server/mock.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MockRuntime concurrent sessions", () => {
  it("keeps addressed background compaction from changing the selected run state", async () => {
    vi.useFakeTimers();
    const runtime = new MockRuntime();
    await runtime.openSession("mock-active");
    await runtime.openSession("mock-history");
    await runtime.prompt({
      sessionId: "mock-history",
      message: "selected work",
    });

    await runtime.compact("mock-active");
    const snapshot = await runtime.snapshot();
    expect(snapshot.active?.sessionId).toBe("mock-history");
    expect(snapshot.runState).toBe("running");
    expect(snapshot.sessionStatuses["mock-history"]).toEqual({
      runState: "running",
      indicator: "running",
    });
    await runtime.close();
  });

  it("keeps a configured stream observable until its interval elapses", async () => {
    vi.useFakeTimers();
    const runtime = new MockRuntime({ streamIntervalMs: 250 });
    await runtime.openSession("mock-active");
    await runtime.prompt({ sessionId: "mock-active", message: "paced task" });

    await vi.advanceTimersByTimeAsync(249);
    expect((await runtime.snapshot()).runState).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    expect((await runtime.snapshot()).runState).toBe("running");
    await runtime.close();
  });

  it("keeps background streams attributed to their owning session", async () => {
    vi.useFakeTimers();
    const runtime = new MockRuntime();
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );

    await runtime.openSession("mock-active");
    await runtime.prompt({ sessionId: "mock-active", message: "first task" });
    await runtime.openSession("mock-history");
    await runtime.prompt({ sessionId: "mock-history", message: "second task" });
    await vi.runAllTimersAsync();

    const snapshot = await runtime.snapshot();
    expect(snapshot.active?.sessionId).toBe("mock-history");
    expect(snapshot.sessionStatuses["mock-active"]).toEqual({
      runState: "idle",
      indicator: "completed",
    });
    expect(snapshot.sessionStatuses["mock-history"]).toEqual({
      runState: "idle",
    });

    const updates = events.filter((event) => event.type === "message_update");
    expect(updates.some((event) => event.sessionId === "mock-active")).toBe(
      true,
    );
    expect(updates.some((event) => event.sessionId === "mock-history")).toBe(
      true,
    );

    const reopened = await runtime.openSession("mock-active");
    expect(reopened.sessionStatuses["mock-active"]).toEqual({
      runState: "idle",
    });
    expect(JSON.stringify(reopened.active?.transcriptPage.messages)).toContain(
      "first task",
    );
    await runtime.close();
  });
});
