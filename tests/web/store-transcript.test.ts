// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeSnapshot, deferred, installFakeWebSocket } from "./helpers";
import { initStore, installStoreSnapshot } from "./store-fixture";

describe("transcript paging", () => {
  beforeEach(() => installFakeWebSocket());
  afterEach(() => vi.useRealTimers());

  it("keeps a stale activity range retryable and materializes it in order", async () => {
    const message = (role: string, timestamp: number) => ({
      role,
      timestamp,
      content: `message ${timestamp}`,
      __inspireMessageId: `message-${timestamp}`,
    });
    const address = {
      sessionId: "s1",
      viewId: "view-s1",
      incarnation: "projection-1",
      revision: 4,
      appendFromRevision: 1,
    };
    const requested: string[] = [];
    let stale = true;
    installStoreSnapshot(
      activeSnapshot({
        transcriptPage: {
          ...address,
          messages: [message("user", 5)],
          hasOlder: true,
          olderCursor: "older-1",
        },
      }),
      (url) => {
        if (url.startsWith("/api/transcript/older"))
          return {
            body: {
              ...address,
              messages: [message("assistant", 1)],
              activityRanges: [
                {
                  cursor: "tail",
                  afterMessageId: "message-1",
                  messageCount: 3,
                  kinds: ["tool"],
                },
              ],
              hasOlder: false,
              olderCursor: null,
            },
          };
        if (url.startsWith("/api/transcript/activity")) {
          const cursor = new URL(url, "http://localhost").searchParams.get(
            "cursor",
          )!;
          requested.push(cursor);
          if (stale)
            return { status: 409, body: { error: "activity cursor is stale" } };
          const tail = cursor === "tail";
          return {
            body: {
              ...address,
              messages: (tail ? [3, 4] : [2]).map((time) =>
                message("toolResult", time),
              ),
              hasMore: tail,
              cursor: tail ? "remainder" : null,
            },
          };
        }
        if (url.startsWith("/api/snapshot"))
          return { status: 503, body: { error: "refresh unavailable" } };
      },
    );
    const { store } = await initStore();
    const order = () =>
      store.getState().messages.map((message) => message.timestamp);
    await store.loadOlderMessages();
    expect(order()).toEqual([1, 5]);

    await store.materializeActivityRanges(["tail"]);
    expect(store.getState().transcriptActivityRanges).toMatchObject([
      { cursor: "tail", status: "error", error: "activity cursor is stale" },
    ]);
    expect(order()).toEqual([1, 5]);

    stale = false;
    const beforeCommit = vi.fn();
    await store.materializeActivityRanges(["tail"], beforeCommit, "tail");
    expect(requested).toEqual(["tail", "tail"]);
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(order()).toEqual([1, 3, 4, 5]);
    expect(store.getState().transcriptActivityRanges).toMatchObject([
      {
        cursor: "remainder",
        afterMessageId: "message-1",
        messageCount: 1,
        status: "idle",
      },
    ]);

    await store.materializeActivityRanges(["remainder"], beforeCommit);
    expect(requested).toEqual(["tail", "tail", "remainder"]);
    expect(order()).toEqual([1, 2, 3, 4, 5]);
    expect(store.getState().transcriptActivityRanges).toEqual([]);
  });

  describe("older-page recovery ownership", () => {
    function installPaging(
      read: (cursor: string | null) => { status?: number; body: unknown },
    ) {
      installStoreSnapshot(
        activeSnapshot({
          transcriptPage: {
            revision: 4,
            messages: [{ role: "user", content: "new", timestamp: 2 }],
            hasOlder: true,
            olderCursor: "cursor-1",
          },
        }),
        (url) =>
          url.startsWith("/api/transcript/older")
            ? read(new URL(url, "http://localhost").searchParams.get("cursor"))
            : undefined,
      );
    }

    it("keeps one load pending through backoff and recovers after persistent failure", async () => {
      const read = vi.fn<
        (cursor: string | null) => { status: number; body: unknown }
      >(() => ({
        status: 503,
        body: { error: "Earlier messages unavailable" },
      }));
      installPaging(read);
      const { store } = await initStore();
      vi.useFakeTimers();

      const loading = store.loadOlderMessages();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledOnce();
      expect(store.getState()).toMatchObject({
        loadingOlderMessages: true,
        olderMessagesError: null,
      });
      const coalesced = store.loadOlderMessages();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledOnce();

      await vi.runAllTimersAsync();
      await expect(Promise.all([loading, coalesced])).resolves.toEqual([
        false,
        false,
      ]);
      expect(read.mock.calls.length).toBeGreaterThan(1);
      expect(read.mock.calls.every(([cursor]) => cursor === "cursor-1")).toBe(
        true,
      );
      expect(store.getState()).toMatchObject({
        loadingOlderMessages: false,
        olderMessagesError: "Earlier messages unavailable",
        olderMessagesCursor: "cursor-1",
        messages: [{ content: "new" }],
      });
      read.mockImplementationOnce(() => ({
        status: 503,
        body: { error: "Temporary failure" },
      }));
      read.mockReturnValue({
        status: 200,
        body: {
          sessionId: "s1",
          viewId: "view-s1",
          revision: 4,
          messages: [{ role: "user", content: "earlier", timestamp: 1 }],
          hasOlder: false,
          olderCursor: null,
        },
      });
      const recovery = store.loadOlderMessages();
      await vi.runAllTimersAsync();
      await expect(recovery).resolves.toBe(true);
      expect(store.getState()).toMatchObject({
        olderMessagesError: null,
        messages: [{ content: "earlier" }, { content: "new" }],
      });
    });

    it.each([
      ["missing view", { viewId: undefined }],
      ["different view", { viewId: "another-view" }],
      ["stale revision", { revision: 3 }],
    ])("rejects an older page with a %s", async (_name, invalid) => {
      installPaging(() => ({
        body: {
          sessionId: "s1",
          revision: 4,
          viewId: "view-s1",
          messages: [{ role: "user", content: "foreign page", timestamp: 1 }],
          hasOlder: false,
          olderCursor: null,
          ...invalid,
        },
      }));
      const { store } = await initStore();
      await expect(store.loadOlderMessages()).resolves.toBe(false);
      expect(
        store.getState().messages.map((message) => message.content),
      ).toEqual(["new"]);
      expect(store.getState()).toMatchObject({
        loadingOlderMessages: false,
        hasOlderMessages: true,
        olderMessagesCursor: "cursor-1",
        transcriptRevision: 4,
      });
    });

    it.each(["view", "transport"] as const)(
      "retires the queued older read after its %s changes",
      async (change) => {
        const read = vi.fn(() => ({
          status: 503,
          body: { error: "Old read unavailable" },
        }));
        installPaging(read);
        const { store, socket } = await initStore();
        vi.useFakeTimers();
        const loading = store.loadOlderMessages();
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        if (change === "view")
          socket.emit({
            type: "snapshot",
            data: activeSnapshot({
              transcriptPage: {
                revision: 4,
                viewId: "other-view",
                messages: [
                  { role: "user", content: "other view", timestamp: 3 },
                ],
              },
            }),
          });
        else await store.init();
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(loading).resolves.toBe(false);
        expect(read).toHaveBeenCalledTimes(1);
        expect(store.getState().olderMessagesError).toBeNull();
        expect(store.getState().loadingOlderMessages).toBe(false);
      },
    );
  });

  it.each(["append", "rewrite", "branch change"] as const)(
    "preserves paged history through append and settlement, but retires it on replacement (%s)",
    async (transition) => {
      const gate = deferred<void>();
      const requested = deferred<void>();
      const append = transition === "append";
      const viewId = transition === "branch change" ? "view-b" : "view-a";
      const newer = {
        role: "user",
        content: "new",
        timestamp: 2,
        __inspireMessageId: "m2:0",
      };
      const replacement = {
        role: "assistant",
        content: transition,
        timestamp: 3,
        __inspireMessageId: "m3:0",
      };
      const identity = {
        viewId: "view-a",
        incarnation: "incarnation",
        effectiveLeafId: "m2",
      };
      const saved = {
        ...replacement,
        content: "persisted reply",
        timestamp: 4,
        __inspireMessageId: "m4:0",
      };
      const committed = activeSnapshot({
        effectiveLeafId: "m4",
        transcriptPage: {
          ...identity,
          revision: 6,
          appendFromRevision: 1,
          effectiveLeafId: "m4",
          messages: [newer, replacement, saved],
        },
      });
      installStoreSnapshot(
        activeSnapshot({
          transcriptPage: {
            ...identity,
            revision: 4,
            messages: [newer],
            hasOlder: true,
            olderCursor: "cursor-1",
          },
          effectiveLeafId: "m2",
        }),
        async (url) => {
          if (url.startsWith("/api/snapshot")) return { body: committed };
          if (url.startsWith("/api/transcript/older")) {
            requested.resolve();
            await gate.promise;
            return {
              body: {
                ...identity,
                sessionId: "s1",
                revision: append ? 5 : 4,
                appendFromRevision: 1,
                effectiveLeafId: append ? "m3" : "m2",
                messages: [
                  {
                    role: "user",
                    content: "old",
                    timestamp: 1,
                    __inspireMessageId: "m1:0",
                  },
                ],
                hasOlder: false,
                olderCursor: null,
              },
            };
          }
        },
      );
      const { store, socket } = await initStore();
      const loading = store.loadOlderMessages();
      await requested.promise;
      expect(store.getState().loadingOlderMessages).toBe(true);

      const intervening = activeSnapshot({
        transcriptPage: {
          ...identity,
          viewId,
          revision: transition === "branch change" ? 4 : 5,
          ...(transition === "rewrite" ? { appendFromRevision: 5 } : {}),
          effectiveLeafId: "m3",
          messages: append ? [newer, replacement] : [replacement],
          ...(append ? { hasOlder: true, olderCursor: "cursor-1" } : {}),
        },
        effectiveLeafId: "m3",
      });
      socket.emit({ type: "snapshot", data: intervening });
      if (append) expect(store.getState().loadingOlderMessages).toBe(true);
      gate.resolve();
      await expect(loading).resolves.toBe(append);
      expect(store.getState()).toMatchObject({
        transcriptViewId: viewId,
        loadingOlderMessages: false,
        hasOlderMessages: false,
      });
      const messages = () =>
        store.getState().messages.map((message) => message.content);
      expect(messages()).toEqual(
        append ? ["old", "new", "append"] : [transition],
      );
      if (!append) return;

      socket.emit({ type: "snapshot", data: intervening });
      expect(messages()).toEqual(["old", "new", "append"]);
      socket.emit({
        type: "message_start",
        sessionId: "s1",
        message: {
          role: "assistant",
          content: "partial reply",
          timestamp: 4,
          __inspireLiveId: "live-m4",
        },
      });
      expect(messages()).toEqual(["old", "new", "append", "partial reply"]);
      socket.emit({
        type: "session_projection_changed",
        sessionId: "s1",
        revision: 6,
        sessionStatus: { runState: "idle" },
      });
      await vi.waitFor(() =>
        expect(messages()).toEqual(["old", "new", "append", "persisted reply"]),
      );
      expect(store.getState().hasOlderMessages).toBe(false);
    },
  );

  it("resyncs rather than accepting a server-rejected stale cursor", async () => {
    let snapshotCalls = 0;
    installStoreSnapshot(
      activeSnapshot({
        transcriptPage: {
          revision: 4,
          messages: [],
          hasOlder: true,
          olderCursor: "old",
        },
      }),
      (url) => {
        if (url.startsWith("/api/transcript/older"))
          return { status: 409, body: { error: "stale" } };
        if (url.startsWith("/api/snapshot")) {
          snapshotCalls += 1;
          return {
            body: activeSnapshot({
              transcriptPage: {
                revision: 5,
                messages: [
                  { role: "assistant", content: "fresh", timestamp: 5 },
                ],
              },
            }),
          };
        }
      },
    );
    const { store } = await initStore();
    await store.loadOlderMessages();
    expect(snapshotCalls).toBe(1);
    expect(store.getState().transcriptRevision).toBe(5);
    expect(store.getState().messages[0]).toMatchObject({ content: "fresh" });
  });
});
