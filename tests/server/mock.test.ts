import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRuntime } from "../../server/mock.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MockRuntime concurrent sessions", () => {
  it("keeps background streams attributed to their owning session", async () => {
    vi.useFakeTimers();
    const runtime = new MockRuntime();
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event as Record<string, unknown>));

    await runtime.openSession("mock-active");
    await runtime.prompt({ message: "first task" });
    await runtime.openSession("mock-history");
    await runtime.prompt({ message: "second task" });
    await vi.runAllTimersAsync();

    const snapshot = await runtime.snapshot();
    expect(snapshot.active?.sessionId).toBe("mock-history");
    expect(snapshot.sessionStatuses["mock-active"]).toEqual({ runState: "idle", indicator: "completed" });
    expect(snapshot.sessionStatuses["mock-history"]).toEqual({ runState: "idle" });

    const updates = events.filter((event) => event.type === "message_update");
    expect(updates.some((event) => event.sessionId === "mock-active")).toBe(true);
    expect(updates.some((event) => event.sessionId === "mock-history")).toBe(true);

    const reopened = await runtime.openSession("mock-active");
    expect(reopened.sessionStatuses["mock-active"]).toEqual({ runState: "idle" });
    expect(JSON.stringify(reopened.active?.messages)).toContain("first task");
    await runtime.close();
  });
});
