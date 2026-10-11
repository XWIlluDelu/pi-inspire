// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  installFakeWebSocket,
  installFetch,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

describe("transcript paging", () => {
  beforeEach(() => installFakeWebSocket());

  it("materializes a bounded activity tail before expanding the complete range", async () => {
    const requested: string[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                messages: [
                  {
                    role: "user",
                    content: "new",
                    timestamp: 5,
                    __inspireMessageId: "new-id",
                  },
                ],
                hasOlder: true,
                olderCursor: "older-1",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/older")) {
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-s1",
            incarnation: "projection-1",
            appendFromRevision: 1,
            messages: [
              {
                role: "assistant",
                content: "response",
                timestamp: 1,
                __inspireMessageId: "response-id",
              },
            ],
            activityRanges: [
              {
                cursor: "activity-2",
                afterMessageId: "response-id",
                messageCount: 3,
                kinds: ["tool"],
              },
            ],
            hasOlder: false,
            olderCursor: null,
          },
        };
      }
      if (url.startsWith("/api/transcript/activity")) {
        const cursor =
          new URL(url, "http://localhost").searchParams.get("cursor") ?? "";
        requested.push(cursor);
        return cursor === "activity-2"
          ? {
              body: {
                sessionId: "s1",
                revision: 4,
                viewId: "view-s1",
                incarnation: "projection-1",
                appendFromRevision: 1,
                messages: [
                  {
                    role: "toolResult",
                    content: "second",
                    timestamp: 3,
                    __inspireMessageId: "activity-id-2",
                  },
                  {
                    role: "toolResult",
                    content: "third",
                    timestamp: 4,
                    __inspireMessageId: "activity-id-3",
                  },
                ],
                hasMore: true,
                cursor: "activity-1",
              },
            }
          : {
              body: {
                sessionId: "s1",
                revision: 4,
                viewId: "view-s1",
                incarnation: "projection-1",
                appendFromRevision: 1,
                messages: [
                  {
                    role: "toolResult",
                    content: "first",
                    timestamp: 2,
                    __inspireMessageId: "activity-id-1",
                  },
                ],
                hasMore: false,
                cursor: null,
              },
            };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.loadOlderMessages();
    expect(
      store.getState().messages.map((message) => message.timestamp),
    ).toEqual([1, 5]);
    expect(store.getState().transcriptActivityRanges).toMatchObject([
      { cursor: "activity-2", status: "idle" },
    ]);

    const beforeCommit = vi.fn();
    await store.materializeActivityRanges(["activity-2"], beforeCommit, "tail");
    expect(requested).toEqual(["activity-2"]);
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(
      store.getState().messages.map((message) => message.timestamp),
    ).toEqual([1, 3, 4, 5]);
    expect(
      store
        .getState()
        .messages.slice(1, 3)
        .map((message) => message.__inspireActivityRangeCursor),
    ).toEqual(["activity-2", "activity-2"]);
    expect(store.getState().transcriptActivityRanges).toMatchObject([
      {
        cursor: "activity-1",
        afterMessageId: "response-id",
        messageCount: 1,
        status: "idle",
      },
    ]);

    await store.materializeActivityRanges(["activity-1"], beforeCommit);
    expect(requested).toEqual(["activity-2", "activity-1"]);
    expect(beforeCommit).toHaveBeenCalledTimes(2);
    expect(
      store.getState().messages.map((message) => message.timestamp),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(store.getState().transcriptActivityRanges).toEqual([]);
  });

  it("leaves stale deferred activity retryable when its authoritative refresh fails", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                messages: [
                  {
                    role: "assistant",
                    content: "response",
                    timestamp: 1,
                    __inspireMessageId: "response-id",
                  },
                ],
                activityRanges: [
                  {
                    cursor: "stale-activity",
                    afterMessageId: "response-id",
                    messageCount: 1,
                    kinds: ["tool"],
                  },
                ],
              },
            }),
          }),
        };
      if (url.startsWith("/api/transcript/activity"))
        return { status: 409, body: { error: "activity cursor is stale" } };
      if (url.startsWith("/api/snapshot"))
        return { status: 503, body: { error: "refresh unavailable" } };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await store.materializeActivityRanges(["stale-activity"]);

    expect(store.getState().transcriptActivityRanges).toMatchObject([
      {
        cursor: "stale-activity",
        status: "error",
        error: "activity cursor is stale",
      },
    ]);
  });

  it("uses each returned cursor to load consecutive older pages", async () => {
    const requested: string[] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                messages: [{ role: "user", content: "new", timestamp: 3 }],
                hasOlder: true,
                olderCursor: "cursor-2",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/older")) {
        const cursor =
          new URL(url, "http://localhost").searchParams.get("cursor") ?? "";
        requested.push(cursor);
        return cursor === "cursor-2"
          ? {
              body: {
                sessionId: "s1",
                revision: 4,
                messages: [
                  { role: "assistant", content: "middle", timestamp: 2 },
                  { role: "user", content: "new duplicate", timestamp: 3 },
                ],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
            }
          : {
              body: {
                sessionId: "s1",
                revision: 4,
                messages: [{ role: "user", content: "old", timestamp: 1 }],
                hasOlder: false,
                olderCursor: null,
              },
            };
      }
      return baseRoutes(url, init);
    });

    const { store } = await initStore();
    expect(await store.loadOlderMessages()).toBe(true);
    expect(await store.loadOlderMessages()).toBe(true);
    expect(requested).toEqual(["cursor-2", "cursor-1"]);
    expect(
      store.getState().messages.map((message) => message.timestamp),
    ).toEqual([1, 2, 3]);
    expect(store.getState().hasOlderMessages).toBe(false);
    expect(store.getState().olderMessagesCursor).toBeNull();
    expect(store.getState().olderMessagesError).toBeNull();
  });

  it("keeps a failed automatic page local to the transcript and clears it on retry", async () => {
    let attempts = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                messages: [{ role: "user", content: "new", timestamp: 2 }],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/older")) {
        attempts += 1;
        if (attempts === 1)
          return { status: 503, body: { error: "temporarily unavailable" } };
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            messages: [{ role: "user", content: "old", timestamp: 1 }],
            hasOlder: false,
            olderCursor: null,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    expect(await store.loadOlderMessages()).toBe(false);
    expect(store.getState().olderMessagesError).toBe("temporarily unavailable");
    expect(store.getState().error).toBeNull();

    expect(await store.loadOlderMessages()).toBe(true);
    expect(store.getState().olderMessagesError).toBeNull();
    expect(
      store.getState().messages.map((message) => message.timestamp),
    ).toEqual([1, 2]);
  });

  it("discards a delayed older page from branch A after same-session switch to branch B", async () => {
    const { promise: gate, resolve: release } = deferred<void>();
    const { promise: requested, resolve: started } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                viewId: "view-a",
                effectiveLeafId: "leaf-a",
                messages: [{ role: "user", content: "new A", timestamp: 2 }],
                hasOlder: true,
                olderCursor: "cursor-a",
              },
              effectiveLeafId: "leaf-a",
            }),
          }),
        };
      if (url.startsWith("/api/transcript/older")) {
        started();
        await gate;
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-a",
            effectiveLeafId: "leaf-a",
            messages: [{ role: "user", content: "old A", timestamp: 1 }],
            hasOlder: false,
            olderCursor: null,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const loading = store.loadOlderMessages();
    await requested;
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          revision: 4,
          viewId: "view-b",
          effectiveLeafId: "leaf-b",
          messages: [{ role: "assistant", content: "branch B", timestamp: 3 }],
        },
        effectiveLeafId: "leaf-b",
      }),
    });
    release();
    await loading;
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["branch B"],
    );
    expect(store.getState().transcriptViewId).toBe("view-b");
  });

  it("keeps an in-flight older load continuous across an append-lineage snapshot", async () => {
    const { promise: gate, resolve: release } = deferred<void>();
    const { promise: requested, resolve: started } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                viewId: "view-a",
                incarnation: "incarnation",
                effectiveLeafId: "m2",
                messages: [
                  {
                    role: "user",
                    content: "new",
                    timestamp: 2,
                    __inspireMessageId: "m2:0",
                  },
                ],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
              effectiveLeafId: "m2",
            }),
          }),
        };
      if (url.startsWith("/api/transcript/older")) {
        started();
        await gate;
        return {
          body: {
            sessionId: "s1",
            revision: 5,
            viewId: "view-a",
            incarnation: "incarnation",
            appendFromRevision: 1,
            effectiveLeafId: "m3",
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
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const loading = store.loadOlderMessages();
    await requested;
    expect(store.getState().loadingOlderMessages).toBe(true);

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          revision: 5,
          viewId: "view-a",
          incarnation: "incarnation",
          effectiveLeafId: "m3",
          messages: [
            {
              role: "user",
              content: "new",
              timestamp: 2,
              __inspireMessageId: "m2:0",
            },
            {
              role: "assistant",
              content: "append",
              timestamp: 3,
              __inspireMessageId: "m3:0",
            },
          ],
          hasOlder: true,
          olderCursor: "cursor-1",
        },
        effectiveLeafId: "m3",
      }),
    });
    expect(store.getState().loadingOlderMessages).toBe(true);

    release();
    await expect(loading).resolves.toBe(true);
    expect(store.getState().loadingOlderMessages).toBe(false);
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["old", "new", "append"],
    );
    expect(store.getState().hasOlderMessages).toBe(false);
  });

  it("discards an in-flight older page when the same view is rewritten", async () => {
    const { promise: gate, resolve: release } = deferred<void>();
    const { promise: requested, resolve: started } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                viewId: "view-a",
                incarnation: "incarnation",
                effectiveLeafId: "m2",
                messages: [
                  {
                    role: "user",
                    content: "new",
                    timestamp: 2,
                    __inspireMessageId: "m2:0",
                  },
                ],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
              effectiveLeafId: "m2",
            }),
          }),
        };
      if (url.startsWith("/api/transcript/older")) {
        started();
        await gate;
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-a",
            incarnation: "incarnation",
            appendFromRevision: 1,
            effectiveLeafId: "m2",
            messages: [
              {
                role: "user",
                content: "stale older",
                timestamp: 1,
                __inspireMessageId: "m1:0",
              },
            ],
            hasOlder: false,
            olderCursor: null,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    const loading = store.loadOlderMessages();
    await requested;

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          revision: 5,
          viewId: "view-a",
          incarnation: "incarnation",
          appendFromRevision: 5,
          effectiveLeafId: "compact",
          messages: [
            {
              role: "user",
              content: "rewritten",
              timestamp: 9,
              __inspireMessageId: "compact:0",
            },
          ],
        },
        effectiveLeafId: "compact",
      }),
    });
    release();

    await expect(loading).resolves.toBe(false);
    expect(store.getState().loadingOlderMessages).toBe(false);
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["rewritten"],
    );
  });

  it("retains loaded older pages across same and append-lineage snapshots", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                viewId: "view-a",
                incarnation: "incarnation",
                effectiveLeafId: "m2",
                messages: [
                  {
                    role: "user",
                    content: "new",
                    timestamp: 2,
                    __inspireMessageId: "m2:0",
                  },
                ],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
              effectiveLeafId: "m2",
            }),
          }),
        };
      if (url.startsWith("/api/transcript/older"))
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            viewId: "view-a",
            incarnation: "incarnation",
            appendFromRevision: 1,
            effectiveLeafId: "m2",
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
      if (url.startsWith("/api/snapshot"))
        return {
          body: activeSnapshot({
            transcriptPage: {
              revision: 5,
              viewId: "view-a",
              incarnation: "incarnation",
              effectiveLeafId: "m3",
              messages: [
                {
                  role: "user",
                  content: "new",
                  timestamp: 2,
                  __inspireMessageId: "m2:0",
                },
                {
                  role: "assistant",
                  content: "append",
                  timestamp: 3,
                  __inspireMessageId: "m3:0",
                },
              ],
            },
            effectiveLeafId: "m3",
          }),
        };
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    await store.loadOlderMessages();
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["old", "new"],
    );

    // Worker warm-up can publish the same authoritative latest page after an
    // older page lands. It must not discard history from the identical view.
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          revision: 4,
          viewId: "view-a",
          incarnation: "incarnation",
          effectiveLeafId: "m2",
          messages: [
            {
              role: "user",
              content: "new",
              timestamp: 2,
              __inspireMessageId: "m2:0",
            },
          ],
          hasOlder: true,
          olderCursor: "cursor-1",
        },
        effectiveLeafId: "m2",
      }),
    });
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["old", "new"],
    );

    socket.emit({
      type: "session_projection_changed",
      sessionId: "s1",
      revision: 5,
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() => expect(store.getState().transcriptRevision).toBe(5));
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["old", "new", "append"],
    );
    expect(store.getState().hasOlderMessages).toBe(false);
  });

  it("does not clear a projection-owned alert when an older page loads successfully", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              projectionHealth: {
                status: "error",
                message: "projection damaged",
              },
              projectionConflict: {
                kind: "projection-failure",
                message: "projection conflict",
                revision: 4,
                incidentId: "incident-projection",
              },
              transcriptPage: {
                revision: 4,
                incarnation: "inc",
                appendFromRevision: 4,
                messages: [
                  {
                    role: "user",
                    content: "new",
                    timestamp: 2,
                    __inspireMessageId: "m2:0",
                  },
                ],
                hasOlder: true,
                olderCursor: "older",
              },
            }),
          }),
        };
      if (url.startsWith("/api/transcript/older"))
        return {
          body: {
            sessionId: "s1",
            revision: 4,
            incarnation: "inc",
            appendFromRevision: 4,
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
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    expect(store.getState().error).toBe("projection conflict");
    await store.loadOlderMessages();
    expect(store.getState().messages.map((message) => message.content)).toEqual(
      ["old", "new"],
    );
    expect(store.getState().projectionError).toBe("projection conflict");
    expect(store.getState().error).toBe("projection conflict");
  });

  it("rejects a stale returned revision without mixing pages", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                messages: [{ role: "user", content: "new", timestamp: 2 }],
                hasOlder: true,
                olderCursor: "cursor-1",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/older")) {
        return {
          body: {
            sessionId: "s1",
            revision: 3,
            messages: [{ role: "user", content: "stale", timestamp: 1 }],
            hasOlder: false,
            olderCursor: null,
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.loadOlderMessages();
    expect(store.getState().messages).toEqual([
      { role: "user", content: "new", timestamp: 2 },
    ]);
    expect(store.getState().transcriptRevision).toBe(4);
    expect(store.getState().loadingOlderMessages).toBe(false);
  });

  it("resyncs rather than accepting a server-rejected stale cursor", async () => {
    let snapshotCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              transcriptPage: {
                revision: 4,
                messages: [],
                hasOlder: true,
                olderCursor: "old",
              },
            }),
          }),
        };
      }
      if (url.startsWith("/api/transcript/older"))
        return { status: 409, body: { error: "stale" } };
      if (url.startsWith("/api/snapshot")) {
        snapshotCalls += 1;
        return {
          body: activeSnapshot({
            transcriptPage: {
              revision: 5,
              messages: [{ role: "assistant", content: "fresh", timestamp: 5 }],
            },
          }),
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.loadOlderMessages();
    expect(snapshotCalls).toBe(1);
    expect(store.getState().transcriptRevision).toBe(5);
    expect(store.getState().messages[0]).toMatchObject({ content: "fresh" });
  });
});
