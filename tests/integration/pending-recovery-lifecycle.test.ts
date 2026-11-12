// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSessionDraft, sessionDraft } from "../../src/session-drafts";
import {
  closeHostApiFixture,
  hostApiFixture,
} from "../server/fixtures/host-api";
import {
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  jsonBody,
  TEST_HOST_AUTHORITY,
} from "../web/helpers";
import { initStore, installStoreRoutes } from "../web/store-fixture";
import { forwardHostRequests } from "./host-requests";

describe("Pending intent and receipt lifecycle", () => {
  let f: Awaited<ReturnType<typeof hostApiFixture>>;
  let forward: ReturnType<typeof forwardHostRequests>;
  beforeEach(async () => {
    installFakeWebSocket();
    deleteSessionDraft("s1");
    f = await hostApiFixture();
    forward = forwardHostRequests(f.application);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await closeHostApiFixture(f);
  });

  it.each(["success", "failed", "unavailable"] as const)(
    "resumes a held Return response when the receipt is %s",
    async (receipt) => {
      const delivery = deferred<void>();
      const admitted = deferred<void>();
      const recover = vi.spyOn(f.runtime, "recoverPending");
      if (receipt === "failed")
        recover.mockRejectedValue(new Error("confirmed recovery failure"));
      else
        recover.mockResolvedValue({
          steering: ["reclaimed input"],
          followUp: [],
        });

      const receiptReads = vi.fn();
      const fetch = installStoreRoutes(async (url, init) => {
        if (url === "/api/pending/recover") {
          const response = await forward(url, init);
          admitted.resolve();
          await delivery.promise;
          return response;
        }
        if (url.startsWith("/api/pending/operations/")) {
          receiptReads();
          return receipt === "unavailable"
            ? {
                status: 503,
                body: { error: "receipt observation unavailable" },
              }
            : forward(url, init);
        }
      });
      const { store } = await initStore();
      const generation = store.getState().transportGeneration;
      const operation = store.recoverPending();
      const expectedDraft = receipt === "failed" ? "" : "reclaimed input";
      try {
        await admitted.promise;
        store.recoverConnection("online");
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
        FakeWebSocket.instances[1]!.open();

        if (receipt === "unavailable") {
          await vi.waitFor(() => expect(receiptReads).toHaveBeenCalledOnce());
          expect(store.getState().pendingAction).toBe("recover");
          expect(store.getState().notices).toEqual([]);
          delivery.resolve();
        }
        await expect(operation).resolves.toBe(receipt !== "failed");
        expect(store.getState()).toMatchObject({
          pendingAction: null,
          transportGeneration: generation,
        });
        expect(recover).toHaveBeenCalledOnce();
        expect(sessionDraft("s1")).toBe(expectedDraft);
        const notices = store.getState().notices;
        expect(notices).toHaveLength(receipt === "failed" ? 1 : 0);
        expect(
          fetch.mock.calls.filter(([url]) =>
            String(url).startsWith("/api/bootstrap"),
          ),
        ).toHaveLength(1);

        delivery.resolve();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(store.getState().notices).toEqual(notices);
      } finally {
        delivery.resolve();
        await operation;
      }
      expect(sessionDraft("s1")).toBe(expectedDraft);
      if (receipt === "failed") {
        recover.mockResolvedValue({ steering: ["new input"], followUp: [] });
        expect(await store.recoverPending()).toBe(true);
        expect(recover).toHaveBeenCalledTimes(2);
        expect(sessionDraft("s1")).toBe("new input");
      }
    },
  );

  it("requires matched Host proof to retire a failed Return intent", async () => {
    const recover = vi
      .spyOn(f.runtime, "recoverPending")
      .mockResolvedValue({ steering: ["retained"], followUp: [] });
    const ids: string[] = [];
    let observing = false;
    installStoreRoutes(async (url, init) => {
      if (url === "/api/pending/recover") {
        ids.push(String(jsonBody(init).operationId));
        const response = await forward(url, init);
        if (observing) return response;
        return {
          status: 500,
          body: { error: "observation failed" },
          headers: {
            "X-Inspire-Authority": TEST_HOST_AUTHORITY,
            ...(ids.length === 2
              ? {
                  "X-Inspire-Pending-Operation": "unmatched-operation",
                  "X-Inspire-Pending-Outcome": "failed",
                }
              : {}),
          },
        };
      }
      if (url.startsWith("/api/pending/operations/")) {
        if (!observing) throw new TypeError("receipt unavailable");
        return forward(url, init);
      }
    });
    const { store } = await initStore();
    // An ordinary HTTP refusal and proof for another operation are both inconclusive.
    expect(await store.recoverPending()).toBe(false);
    expect(ids).toHaveLength(1);
    expect(await store.recoverPending()).toBe(false);
    expect(ids).toEqual([ids[0], ids[0]]);
    observing = true;
    expect(await store.recoverPending()).toBe(true);
    expect(ids).toEqual([ids[0], ids[0], ids[0]]);
    expect(recover).toHaveBeenCalledOnce();
    expect(sessionDraft("s1")).toBe("retained");
  });

  it("ends retired observation without redispatching its tombstone, then accepts a new explicit Return", async () => {
    let lost = true;
    const requests: Record<string, unknown>[] = [];
    const recover = vi
      .spyOn(f.runtime, "recoverPending")
      .mockResolvedValue({ steering: ["original"], followUp: [] });
    installStoreRoutes(async (url, init) => {
      if (url === "/api/pending/recover") {
        requests.push(jsonBody(init));
        const response = await forward(url, init);
        if (lost) throw new TypeError("lost response");
        return response;
      }
      if (url.startsWith("/api/pending/operations/")) {
        if (lost) throw new TypeError("lost receipt");
        return forward(url, init);
      }
    });
    const { store } = await initStore();
    expect(await store.recoverPending()).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    lost = false;
    expect(await store.recoverPending()).toBe(false);
    expect(recover).toHaveBeenCalledOnce();
    recover.mockResolvedValue({ steering: ["current queue"], followUp: [] });
    expect(await store.recoverPending()).toBe(true);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]?.operationId).not.toBe(requests[0]?.operationId);
    expect(sessionDraft("s1")).toBe("current queue");
    const retired = await forward("/api/pending/recover", {
      method: "POST",
      body: JSON.stringify(requests[0]),
    });
    expect(retired).toMatchObject({
      status: 409,
      body: { code: "PENDING_OPERATION_RESULT_RETIRED" },
    });
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it("returns newly admitted input without replacing the unknown older queue's receipt", async () => {
    let readOld = false,
      posts = 0;
    const ids: string[] = [];
    const recover = vi
      .spyOn(f.runtime, "recoverPending")
      .mockImplementation(async () => ({
        steering: [++posts === 1 ? "old queue" : "new queue"],
        followUp: [],
      }));
    installStoreRoutes(async (url, init) => {
      if (url === "/api/pending/recover") {
        ids.push(String(jsonBody(init).operationId));
        const response = await forward(url, init);
        if (ids.length === 1) throw new TypeError("lost response");
        return response;
      }
      if (url.startsWith("/api/pending/operations/")) {
        if (!readOld) throw new TypeError("lost receipt");
        return forward(url, init);
      }
    });
    const { store, socket } = await initStore();
    expect(await store.recoverPending()).toBe(false);
    readOld = true;
    socket.emit({
      type: "queue_update",
      sessionId: "s1",
      pendingQueues: {
        revision: 7,
        totalCount: 1,
        steering: [],
        followUp: [],
      },
    });
    expect(await store.recoverPending()).toBe(true);
    await vi.waitFor(() => expect(sessionDraft("s1")).toContain("old queue"));
    expect(sessionDraft("s1")).toContain("new queue");
    expect(ids[0]).not.toBe(ids[1]);
    expect(recover).toHaveBeenCalledTimes(2);
  });
});
