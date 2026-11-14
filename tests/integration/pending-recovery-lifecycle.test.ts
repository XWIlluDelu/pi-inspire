// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHostApiFixture,
  hostApiFixture,
} from "../server/fixtures/host-api";
import {
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  jsonBody,
} from "../web/helpers";
import { initStore } from "../web/store-fixture";

describe("Pending intent and receipt lifecycle", () => {
  let f: Awaited<ReturnType<typeof hostApiFixture>>;
  const sessionId = "fixture-active";
  const snapshot = () => f.runtime.snapshot(sessionId);
  const connect = async () =>
    initStore(await snapshot(), f.application.authorityId);
  beforeEach(async () => {
    installFakeWebSocket();
    f = await hostApiFixture();
    await f.runtime.openSession(sessionId);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const url = String(input);
        if (url === "/api/pending/recover") {
          const response = await f.fetchHost(input, init);
          admitted.resolve();
          await delivery.promise;
          return response;
        }
        if (url.startsWith("/api/pending/operations/")) {
          receiptReads();
          return receipt === "unavailable"
            ? Response.json(
                { error: "receipt observation unavailable" },
                { status: 503 },
              )
            : f.fetchHost(input, init);
        }
        return f.fetchHost(input, init);
      });
      vi.stubGlobal("fetch", fetch);
      const { store } = await connect();
      const generation = store.getState().transportGeneration;
      const operation = store.recoverPending();
      const expectedDraft = receipt === "failed" ? "" : "reclaimed input";
      try {
        await admitted.promise;
        store.recoverConnection("online");
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
        FakeWebSocket.instances[1]!.join(await snapshot(), {
          authorityId: f.application.authorityId,
        });

        if (receipt === "unavailable") {
          await vi.waitFor(() => expect(receiptReads).toHaveBeenCalledOnce());
          expect(store.getState().pendingAction).toBe("recover");
          expect(store.getState().live.notices).toEqual([]);
          delivery.resolve();
        }
        await expect(operation).resolves.toBe(receipt !== "failed");
        expect(store.getState()).toMatchObject({
          pendingAction: null,
          transportGeneration: generation,
        });
        expect(recover).toHaveBeenCalledOnce();
        expect(store.drafts.get(sessionId).text).toBe(expectedDraft);
        const notices = store.getState().live.notices;
        expect(notices).toHaveLength(receipt === "failed" ? 1 : 0);
        expect(
          fetch.mock.calls.filter(([url]) =>
            String(url).startsWith("/api/bootstrap"),
          ),
        ).toHaveLength(1);

        delivery.resolve();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(store.getState().live.notices).toEqual(notices);
      } finally {
        delivery.resolve();
        await operation;
      }
      expect(store.drafts.get(sessionId).text).toBe(expectedDraft);
      if (receipt === "failed") {
        recover.mockResolvedValue({ steering: ["new input"], followUp: [] });
        expect(await store.recoverPending()).toBe(true);
        expect(recover).toHaveBeenCalledTimes(2);
        expect(store.drafts.get(sessionId).text).toBe("new input");
      }
    },
  );

  it.each(["same queue", "new queue", "retired receipt"] as const)(
    "keeps an unresolved Return addressed through $0",
    async (outcome) => {
      let observeOld = false;
      let reads = 0;
      const requests: Record<string, unknown>[] = [];
      const recover = vi
        .spyOn(f.runtime, "recoverPending")
        .mockResolvedValueOnce({ steering: ["old queue"], followUp: [] })
        .mockResolvedValue({ steering: ["new queue"], followUp: [] });
      vi.stubGlobal("fetch", (async (input, init) => {
        const url = String(input);
        if (url === "/api/pending/recover") {
          requests.push(jsonBody(init ?? {}));
          const response = await f.fetchHost(input, init);
          if (requests.length === 1) throw new TypeError("lost response");
          return response;
        }
        if (!observeOld && url.startsWith("/api/pending/operations/")) {
          expect(url).toContain(requests[0]!.operationId);
          if (++reads === 1) throw new TypeError("lost receipt");
          return Response.json(
            {
              executor: {
                kind: "host",
                authorityId: f.application.authorityId,
              },
              command: "recover",
              operationId: "another-operation",
              state: "rejected",
              error: { status: 409, message: "Another operation failed" },
            },
            { status: 409 },
          );
        }
        return f.fetchHost(input, init);
      }) satisfies typeof fetch);
      const { store, socket } = await connect();
      expect(await store.recoverPending()).toBe(false);
      expect(await store.recoverPending()).toBe(false);
      expect(recover).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(1);
      observeOld = true;

      if (outcome === "same queue") {
        expect(await store.recoverPending()).toBe(true);
        expect(store.drafts.get(sessionId).text).toBe("old queue");
        expect(recover).toHaveBeenCalledOnce();
        return;
      }
      if (outcome === "retired receipt") {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 16 * 60_000);
        expect(await store.recoverPending()).toBe(false);
        const retired = await f.fetchHost("/api/pending/recover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requests[0]),
        });
        expect(retired.status).toBe(409);
        expect(await retired.json()).toMatchObject({
          code: "PENDING_OPERATION_RESULT_RETIRED",
        });
        expect(recover).toHaveBeenCalledOnce();
      }
      socket.emit({
        type: "queue_update",
        sessionId,
        pendingQueues: {
          revision: 7,
          totalCount: 1,
          steering: [],
          followUp: [],
        },
      });
      expect(await store.recoverPending()).toBe(true);
      await vi.waitFor(() => {
        const draft = store.drafts.get(sessionId).text.split("\n\n").sort();
        expect(draft).toEqual(
          outcome === "new queue" ? ["new queue", "old queue"] : ["new queue"],
        );
      });
      expect(requests[1]?.operationId).not.toBe(requests[0]?.operationId);
      expect(recover).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["Return", "Stop"] as const)(
    "keeps the original draft when $0 settles after selecting another session",
    async (delayed) => {
      const released = deferred<void>();
      const admitted = deferred<void>();
      const recover = vi.spyOn(f.runtime, "recoverPending").mockResolvedValue({
        steering: ["first handoff"],
        followUp: [],
      });
      const abort = vi.spyOn(f.runtime, "abort").mockResolvedValue({
        steering: [],
        followUp: ["late input"],
      });
      const returnPath = "/api/pending/recover";
      const stopPath = "/api/control/abort";
      const heldPath = delayed === "Return" ? returnPath : stopPath;
      vi.stubGlobal("fetch", (async (input, init) => {
        const url = String(input);
        if (url === stopPath)
          expect(store.drafts.get(sessionId).text).toBe(
            "first handoff\n\noriginal draft",
          );
        const response = await f.fetchHost(input, init);
        if (url === heldPath) {
          admitted.resolve();
          await released.promise;
        }
        return response;
      }) satisfies typeof fetch);

      const { store } = await connect();
      const nextSession = "fixture-history";
      store.drafts.setText(sessionId, "original draft");
      const stopping = store.abort();
      try {
        await admitted.promise;
        await store.openSession(nextSession);
        store.drafts.setText(nextSession, "another draft");
        if (delayed === "Return") {
          await store.init();
          FakeWebSocket.instances
            .at(-1)!
            .join(await f.runtime.snapshot(nextSession), {
              authorityId: f.application.authorityId,
            });
          await vi.waitFor(() =>
            expect(store.drafts.get(sessionId).text).toBe(
              "first handoff\n\noriginal draft",
            ),
          );
        } else {
          store.drafts.setText(sessionId, "edited during Stop");
        }
      } finally {
        released.resolve();
        await stopping;
      }
      expect(recover).toHaveBeenCalledOnce();
      expect(recover.mock.calls[0]?.[0]).toBe(sessionId);
      expect(abort).toHaveBeenCalledTimes(delayed === "Return" ? 0 : 1);
      if (delayed === "Stop") expect(abort.mock.calls[0]?.[0]).toBe(sessionId);
      expect(store.getState().sessionId).toBe(nextSession);
      expect(store.drafts.get(nextSession).text).toBe("another draft");
      expect(store.drafts.get(sessionId).text).toBe(
        delayed === "Return"
          ? "first handoff\n\noriginal draft"
          : "late input\n\nedited during Stop",
      );
    },
  );
});
