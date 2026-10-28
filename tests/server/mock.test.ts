import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRuntime } from "../../server/mock.js";
import { HISTORY_FIXTURE_SESSION_ID } from "../../server/mock-history.js";
import { BRANCH_CONTENT_PAGE_CHARS } from "../../server/session-tree.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MockRuntime History reads", () => {
  it.each(["mock-history", HISTORY_FIXTURE_SESSION_ID])(
    "keeps a warmed History index readable after continuing %s",
    async (sessionId) => {
      vi.useFakeTimers();
      const runtime = new MockRuntime();
      try {
        await runtime.openSession(sessionId);
        const before = await runtime.branchTree(sessionId);
        await runtime.prompt({ sessionId, message: "Continue this branch" });
        const during = await runtime.branchTree(sessionId);
        expect(during.revision).toBeGreaterThan(before.revision);
        expect(during.activePath).toContain(before.effectiveLeafId);
        expect(during.effectiveLeafId).not.toBe(before.effectiveLeafId);
        await vi.runAllTimersAsync();
        const snapshot = await runtime.snapshot(sessionId);
        const after = await runtime.branchTree(sessionId);
        expect(after.effectiveLeafId).toBe(snapshot.active!.effectiveLeafId);
        const detail = await runtime.branchEntry({
          sessionId,
          viewId: snapshot.active!.transcriptPage.viewId,
          targetId: after.effectiveLeafId!,
        });
        expect(detail.text).toContain("Continue this branch");
      } finally {
        await runtime.close();
      }
    },
  );

  it("retains the complete saved branch after navigation and cloning", async () => {
    const runtime = new MockRuntime();
    let cloneId: string | undefined;
    try {
      await runtime.openSession(HISTORY_FIXTURE_SESSION_ID);
      const tree = await runtime.branchTree(HISTORY_FIXTURE_SESSION_ID);
      const { snapshot } = await runtime.navigateBranch({
        sessionId: HISTORY_FIXTURE_SESSION_ID,
        revision: tree.revision,
        targetId: tree.effectiveLeafId!,
        mode: "switch",
      });
      const page = snapshot.active!.transcriptPage;
      expect(page.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ entryId: "history-u-0" }),
          expect.objectContaining({
            entryId: "history-shell-included",
            role: "bashExecution",
          }),
          expect.objectContaining({ entryId: "history-latest" }),
        ]),
      );
      const identities = page.messages.map(
        (message) =>
          (message as { __inspireMessageId: string }).__inspireMessageId,
      );
      expect(new Set(identities).size).toBe(page.messages.length);
      expect(page.hasOlder).toBe(false);
      const cloned = await runtime.cloneBranch({
        sessionId: HISTORY_FIXTURE_SESSION_ID,
        viewId: (await runtime.snapshot()).active!.transcriptPage.viewId,
        targetId: page.effectiveLeafId ?? null,
      });
      cloneId = cloned.sessionId;
      expect(cloned.snapshot.active!.transcriptPage.messages).toEqual(
        page.messages,
      );
    } finally {
      if (cloneId) {
        await runtime.deselectSession();
        await runtime.deleteSession(cloneId);
      }
      await runtime.close();
    }
  });

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

describe("MockRuntime addressed bootstrap", () => {
  it("restores an unopened catalog fixture without changing the Host selection", async () => {
    const runtime = new MockRuntime();
    try {
      await runtime.openSession("mock-history");
      const selected = await runtime.snapshot();
      const addressed = await runtime.snapshot("mock-active");
      expect(addressed.active?.sessionId).toBe("mock-active");
      expect(addressed.active?.transcriptPage.messages.length).toBeGreaterThan(
        0,
      );
      expect(addressed.runState).toBe("idle");
      expect(await runtime.snapshot()).toEqual(selected);
      expect((await runtime.resourceContext("mock-active")).sessionId).toBe(
        "mock-active",
      );
    } finally {
      await runtime.close();
    }
  });

  it("classifies a missing remembered session for bootstrap recovery", async () => {
    const runtime = new MockRuntime();
    try {
      await expect(
        runtime.snapshot("missing-saved-session"),
      ).rejects.toMatchObject({
        status: 404,
        code: "SESSION_NOT_FOUND",
      });
      expect((await runtime.snapshot(null)).active).toBeNull();
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
