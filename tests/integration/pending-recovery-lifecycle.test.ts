// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENTS } from "../../shared/contracts";
import {
  closeHostApiFixture,
  hostApiFixture,
} from "../server/fixtures/host-api";
import { upload } from "../server/fixtures/runtime";
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
  const authority = () => f.application.authorityId;
  const snapshot = (id = sessionId) => f.runtime.snapshot(id);
  const connect = async () => initStore(await snapshot(), authority());
  const returnPath = "/api/pending/recover";
  const receiptPath = "/api/pending/operations/";
  const hold = (path: string, intercept?: typeof fetch) => {
    const delivered = deferred<void>();
    const release = deferred<void>();
    vi.stubGlobal("fetch", (async (input, init) => {
      const url = String(input);
      if (url !== path) return (intercept ?? f.fetchHost)(input, init);
      const response = await f.fetchHost(input, init);
      delivered.resolve();
      await release.promise;
      return response;
    }) satisfies typeof fetch);
    return { delivered, release };
  };
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
      const recover = vi.spyOn(f.runtime, "recoverPending").mockResolvedValue({
        steering: ["reclaimed input"],
        followUp: [],
      });
      if (receipt === "failed")
        recover.mockRejectedValueOnce(new Error("confirmed recovery failure"));
      const receiptReads = vi.fn();
      const { delivered, release } = hold(returnPath, async (input, init) => {
        if (String(input).startsWith(receiptPath)) {
          receiptReads();
          if (receipt === "unavailable")
            return Response.json(
              { error: "observation unavailable" },
              { status: 503 },
            );
        }
        return f.fetchHost(input, init);
      });
      const { store } = await connect();
      const generation = store.getState().transportGeneration;
      const operation = store.recoverPending();
      const expectedDraft = receipt === "failed" ? "" : "reclaimed input";
      try {
        await delivered.promise;
        store.recoverConnection("online");
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
        FakeWebSocket.instances[1]!.join(await snapshot(), {
          authorityId: authority(),
        });
        await vi.waitFor(() => expect(receiptReads).toHaveBeenCalledOnce());

        if (receipt === "unavailable") {
          expect(store.getState().pendingAction?.action).toBe("recover");
          expect(store.getState().live.notices).toEqual([]);
          release.resolve();
        }
        await expect(operation).resolves.toBe(receipt !== "failed");
        expect(store.getState()).toMatchObject({
          pendingAction: null,
          transportGeneration: generation,
        });
        expect(recover).toHaveBeenCalledOnce();
        const notices = store.getState().live.notices;
        expect(notices).toHaveLength(receipt === "failed" ? 1 : 0);
        release.resolve();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(store.getState().live.notices).toEqual(notices);
      } finally {
        release.resolve();
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

  it.each([false, true])(
    "reuses the old Return identity and admits a later queue separately (retired: %s)",
    async (retired) => {
      let observeOld = false;
      let reads = 0;
      const requests: Record<string, unknown>[] = [];
      const recover = vi
        .spyOn(f.runtime, "recoverPending")
        .mockResolvedValueOnce({ steering: ["old queue"], followUp: [] })
        .mockResolvedValue({ steering: ["new queue"], followUp: [] });
      vi.stubGlobal("fetch", (async (input, init) => {
        const url = String(input);
        if (url === returnPath) {
          requests.push(jsonBody(init ?? {}));
          const response = await f.fetchHost(input, init);
          if (requests.length === 1) throw new TypeError("lost response");
          return response;
        }
        if (!observeOld && url.startsWith(receiptPath)) {
          expect(url).toContain(requests[0]!.operationId);
          if (++reads === 1) throw new TypeError("lost receipt");
          return Response.json(
            {
              executor: {
                kind: "host",
                authorityId: authority(),
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

      if (retired) {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 16 * 60_000);
        expect(await store.recoverPending()).toBe(false);
        const replay = await f.fetchHost(returnPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requests[0]),
        });
        expect(replay.status).toBe(409);
        expect(await replay.json()).toMatchObject({
          code: "PENDING_OPERATION_RESULT_RETIRED",
        });
      } else {
        expect(await store.recoverPending()).toBe(true);
        expect(store.drafts.get(sessionId).text).toBe("old queue");
      }
      expect(recover).toHaveBeenCalledOnce();
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
          retired ? ["new queue"] : ["new queue", "old queue"],
        );
      });
      expect(requests[1]?.operationId).not.toBe(requests[0]?.operationId);
      expect(recover).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["Return", "Stop"] as const)(
    "keeps the original draft when $0 settles after selecting another session",
    async (delayed) => {
      const attachments = await Promise.all(
        Array.from({ length: MAX_ATTACHMENTS }, (_, index) =>
          f.attachments.add(upload(`recovered-${index}.png`, "image/png")),
        ),
      );
      const recover = vi.spyOn(f.runtime, "recoverPending").mockResolvedValue({
        steering: ["first handoff"],
        followUp: [],
        attachments,
      });
      const abort = vi
        .spyOn(f.runtime, "abort")
        .mockImplementation(async () => {
          expect(store.drafts.get(sessionId).text).toBe(
            "first handoff\n\noriginal draft",
          );
          return { steering: [], followUp: ["late input"] };
        });
      const { delivered, release } = hold(
        delayed === "Return" ? returnPath : "/api/control/abort",
      );
      const { store } = await connect();
      const nextSession = "fixture-history";
      store.drafts.setText(sessionId, "original draft");
      const { id: saved, ...file } = await f.attachments.add(
        upload("latest.txt", "text/plain"),
      );
      store.drafts.update(sessionId, {
        attachments: [
          {
            localId: "existing-draft-file",
            ...file,
            uploadedId: saved,
            uploadedAuthorityId: authority(),
            status: "ready",
          },
        ],
      });
      store.addProjectFile("README.md");
      const draft = () => store.drafts.get(sessionId);
      const stopping = store.abort();
      try {
        await delivered.promise;
        if (delayed === "Return")
          store.drafts.setText(sessionId, "edited during Return");
        await store.openSession(nextSession);
        store.drafts.setText(nextSession, "another draft");
        if (delayed === "Return") {
          await store.init();
          FakeWebSocket.instances
            .at(-1)!
            .join(await snapshot(nextSession), { authorityId: authority() });
          await vi.waitFor(() =>
            expect(store.drafts.get(sessionId).text).toBe(
              "first handoff\n\nedited during Return",
            ),
          );
        } else {
          store.drafts.setText(sessionId, "edited during Stop");
        }
      } finally {
        release.resolve();
        await stopping;
      }
      expect(recover).toHaveBeenCalledOnce();
      expect(recover.mock.calls[0]?.[0]).toBe(sessionId);
      expect(abort).toHaveBeenCalledTimes(delayed === "Return" ? 0 : 1);
      if (delayed === "Stop") expect(abort.mock.calls[0]?.[0]).toBe(sessionId);
      expect(store.getState().sessionId).toBe(nextSession);
      expect(store.drafts.get(nextSession)).toMatchObject({
        text: "another draft",
        attachments: [],
      });
      expect(draft().text).toBe(
        delayed === "Return"
          ? "first handoff\n\nedited during Return"
          : "late input\n\nedited during Stop",
      );
      expect(draft().projectFiles).toEqual(["README.md"]);
      expect(draft().attachments.map(({ uploadedId }) => uploadedId)).toEqual([
        ...attachments.map(({ id }) => id),
        saved,
      ]);
      if (delayed === "Return") {
        await store.openSession(sessionId);
        expect(await store.sendPrompt(draft().text)).toBe(false);
        expect(store.getState().live.notices.at(-1)?.text).toBe(
          `At most ${MAX_ATTACHMENTS} attachments per message`,
        );
        await vi.waitFor(() =>
          expect(draft().attachments[0]?.previewUrl).toMatch(/^blob:/),
        );
        store.removeAttachment(draft().attachments[0]!.localId);
        await vi.waitFor(async () =>
          expect(
            (await f.fetchHost(`/api/attachments/${attachments[0]!.id}/image`))
              .status,
          ).toBe(404),
        );
      }
    },
  );
});
