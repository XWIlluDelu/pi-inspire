import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRuntime } from "../../server/mock.js";
import { HISTORY_FIXTURE_SESSION_ID } from "../../server/mock-history.js";
import { BRANCH_CONTENT_PAGE_CHARS } from "../../server/session-tree.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MockRuntime History reads", () => {
  it("uses native content-block image coordinates and the shared detail page bound", async () => {
    const runtime = new MockRuntime();
    try {
      const snapshot = await runtime.openSession(HISTORY_FIXTURE_SESSION_ID);
      const request = {
        sessionId: HISTORY_FIXTURE_SESSION_ID,
        viewId: snapshot.active!.transcriptPage.viewId,
        targetId: "history-u-0",
      };
      const detail = await runtime.branchEntry(request);
      expect(detail.text).toBe(
        "Compare the calibration strategies and retain the full measurement record.",
      );
      expect(detail.images).toEqual([{ index: 1, mimeType: "image/gif" }]);
      expect(
        (await runtime.branchImage(request, 1)).data.length,
      ).toBeGreaterThan(0);
      await expect(runtime.branchImage(request, 0)).rejects.toThrow("No image");
      const response = await runtime.branchEntry({
        ...request,
        targetId: "history-a-0",
      });
      expect(response.text).toHaveLength(BRANCH_CONTENT_PAGE_CHARS);
      expect(response.nextOffset).toBe(BRANCH_CONTENT_PAGE_CHARS);
    } finally {
      await runtime.close();
    }
  });
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
