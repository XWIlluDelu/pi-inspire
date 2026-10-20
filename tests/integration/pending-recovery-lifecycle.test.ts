// @vitest-environment jsdom
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSessionDraft, sessionDraft } from "../../src/session-drafts";
import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "../server/fixtures/host-api";
import {
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
  TEST_HOST_AUTHORITY,
} from "../web/helpers";
import { baseRoutes, initStore } from "../web/store-fixture";

describe("Pending intent and receipt lifecycle", () => {
  let f: Awaited<ReturnType<typeof hostApiFixture>>;
  beforeEach(async () => {
    installFakeWebSocket();
    deleteSessionDraft("s1");
    f = await hostApiFixture();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await closeHostApiFixture(f);
  });

  async function forward(
    url: string,
    init: RequestInit,
  ): Promise<RouteResponse> {
    const path = url.replace(TEST_HOST_AUTHORITY, f.application.authorityId);
    const response =
      init.method === "POST"
        ? await request(f.application.server)
            .post(path)
            .set("Authorization", `Bearer ${token}`)
            .send({ ...jsonBody(init), authorityId: f.application.authorityId })
        : await request(f.application.server)
            .get(path)
            .set("Authorization", `Bearer ${token}`);
    return {
      status: response.status,
      body: response.body,
      headers: {
        ...response.headers,
        "x-inspire-authority": TEST_HOST_AUTHORITY,
      },
    };
  }

  it("stops a new run while independently reclaiming the previous Stop's lost result on the same socket", async () => {
    let run = 1,
      lostPost = true,
      lostGet = true;
    const stopped: number[] = [],
      ids: string[] = [];
    vi.spyOn(f.runtime, "abort").mockImplementation(async () => {
      stopped.push(run);
      return { steering: run === 1 ? ["old Stop handoff"] : [], followUp: [] };
    });
    vi.spyOn(f.runtime, "recoverPending").mockResolvedValue({
      steering: [],
      followUp: [],
    });
    installFetch(async (url, init) => {
      if (url === "/api/control/abort") {
        ids.push(String(jsonBody(init).operationId));
        const response = await forward(url, init);
        if (lostPost) {
          lostPost = false;
          throw new TypeError("lost Stop response");
        }
        return response;
      }
      if (url === "/api/pending/recover") return forward(url, init);
      if (url.startsWith("/api/pending/operations/")) {
        const response = await forward(url, init);
        if (lostGet) {
          lostGet = false;
          throw new TypeError("lost receipt");
        }
        return response;
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({ type: "agent_start", sessionId: "s1" });
    await store.abort();
    expect(stopped).toEqual([1]);
    expect(sessionDraft("s1")).toBe("");
    socket.emit({
      type: "agent_settled",
      sessionId: "s1",
      aborted: true,
      sessionStatus: { runState: "aborted" },
    });
    await vi.waitFor(() => expect(store.getState().runState).toBe("idle"));
    run = 2;
    socket.emit({ type: "agent_start", sessionId: "s1" });
    await store.abort();
    await vi.waitFor(() => expect(sessionDraft("s1")).toBe("old Stop handoff"));
    expect(stopped).toEqual([1, 2]);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
    expect(store.getState().connection).toBe("open");
  });

  it("ends a matched failed execution so later explicit Returns can address new input", async () => {
    const recover = vi
      .spyOn(f.runtime, "recoverPending")
      .mockRejectedValueOnce(new Error("transient failure"));
    const ids: string[] = [];
    installFetch(async (url, init) => {
      if (url === "/api/pending/recover") {
        ids.push(String(jsonBody(init).operationId));
        return forward(url, init);
      }
      if (url.startsWith("/api/pending/operations/")) return forward(url, init);
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    expect(await store.recoverPending()).toBe(false);
    expect(recover).toHaveBeenCalledOnce();
    recover.mockResolvedValue({ steering: ["new input"], followUp: [] });
    expect(await store.recoverPending()).toBe(true);
    expect(await store.recoverPending()).toBe(true);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(new Set(ids).size).toBe(3);
  });

  it.each([undefined, "unmatched-operation"])(
    "keeps the retry identity for an unproven 500 (%s), without automatic mutation replay",
    async (proof) => {
      const recover = vi
        .spyOn(f.runtime, "recoverPending")
        .mockResolvedValue({ steering: ["retained"], followUp: [] });
      const ids: string[] = [];
      let observing = false;
      installFetch(async (url, init) => {
        if (url === "/api/pending/recover") {
          ids.push(String(jsonBody(init).operationId));
          if (ids.length === 1) {
            await forward(url, init);
            return {
              status: 500,
              body: { error: "observation failed" },
              headers: {
                "X-Inspire-Authority": TEST_HOST_AUTHORITY,
                ...(proof
                  ? {
                      "X-Inspire-Pending-Operation": proof,
                      "X-Inspire-Pending-Outcome": "failed",
                    }
                  : {}),
              },
            };
          }
          return forward(url, init);
        }
        if (url.startsWith("/api/pending/operations/")) {
          if (!observing) throw new TypeError("receipt unavailable");
          return forward(url, init);
        }
        return baseRoutes(url, init);
      });
      const { store } = await initStore();
      expect(await store.recoverPending()).toBe(false);
      expect(ids).toHaveLength(1);
      observing = true;
      expect(await store.recoverPending()).toBe(true);
      expect(ids[1]).toBe(ids[0]);
      expect(recover).toHaveBeenCalledOnce();
      expect(sessionDraft("s1")).toBe("retained");
    },
  );

  it("ends retired observation without redispatching its tombstone, then accepts a new explicit Return", async () => {
    let lost = true;
    const ids: string[] = [];
    const recover = vi
      .spyOn(f.runtime, "recoverPending")
      .mockResolvedValue({ steering: ["original"], followUp: [] });
    installFetch(async (url, init) => {
      if (url === "/api/pending/recover") {
        ids.push(String(jsonBody(init).operationId));
        const response = await forward(url, init);
        if (lost) throw new TypeError("lost response");
        return response;
      }
      if (url.startsWith("/api/pending/operations/")) {
        if (lost) throw new TypeError("lost receipt");
        return forward(url, init);
      }
      return baseRoutes(url, init);
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
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(sessionDraft("s1")).toBe("current queue");
    const retired = await forward("/api/pending/recover", {
      method: "POST",
      body: JSON.stringify({
        authorityId: TEST_HOST_AUTHORITY,
        sessionId: "s1",
        operationId: ids[0],
      }),
    });
    expect(retired.status).toBe(409);
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
    installFetch(async (url, init) => {
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
      return baseRoutes(url, init);
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
