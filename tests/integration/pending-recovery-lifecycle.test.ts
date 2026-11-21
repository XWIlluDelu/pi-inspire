import { stageUpload } from "../server/fixtures/runtime.js";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHostApiFixture,
  hostApiFixture,
} from "../server/fixtures/host-api";
import { upload } from "../server/fixtures/runtime";
import {
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
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
  const hold = (intercept: typeof fetch = (input, init) => f.fetchHost(input, init)) => {
    const delivered = deferred<void>();
    const release = deferred<void>();
    vi.stubGlobal("fetch", (async (input, init) => {
      const url = String(input);
      if (url !== returnPath) return intercept(input, init);
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
    vi.unstubAllGlobals();
    await closeHostApiFixture(f);
  });

  it("accepts the original Return reply while its receipt read is unavailable", async () => {
    const recover = vi.spyOn(f.runtime, "recoverPending").mockResolvedValue({
      steering: ["reclaimed input"],
      followUp: [],
    });
    const read = vi.fn();
    const { delivered, release } = hold((input, init) => {
      if (!String(input).startsWith(receiptPath)) return f.fetchHost(input, init);
      read();
      return Promise.resolve(Response.json({}, { status: 503 }));
    });
    const { store } = await connect();
    const operation = store.recoverPending();
    try {
      await delivered.promise;
      store.connectionController.recover("online");
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
      FakeWebSocket.instances[1]!.join(await snapshot(), { authorityId: authority() });
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      expect(store.getState().pendingAction?.action).toBe("recover");
    } finally {
      release.resolve();
    }
    await expect(operation).resolves.toBe(true);
    expect(recover).toHaveBeenCalledOnce();
    expect(store.drafts.get(sessionId).text).toBe("reclaimed input");
  });

  it("restores a held Return into its original draft after selection and bootstrap", async () => {
    const attachment = await stageUpload(
      f.attachments,
      upload("recovered.png", "image/png"),
    );
    const recover = vi.spyOn(f.runtime, "recoverPending").mockResolvedValue({
      steering: ["first handoff"],
      followUp: [],
      attachments: [attachment],
    });
    const { delivered, release } = hold();
    const { store } = await connect();
    const nextSession = "fixture-history";
    const recovering = store.recoverPending();
    try {
      await delivered.promise;
      store.drafts.setText(sessionId, "edited during Return");
      await store.openSession(nextSession);
      store.drafts.setText(nextSession, "another draft");
      await store.init();
      FakeWebSocket.instances.at(-1)!.join(await snapshot(nextSession), {
        authorityId: authority(),
      });
      await vi.waitFor(() =>
        expect(store.drafts.get(sessionId)).toMatchObject({
          text: "first handoff\n\nedited during Return",
          attachments: [{ uploadedId: attachment.id }],
        }),
      );
    } finally {
      release.resolve();
      await recovering;
    }
    expect(recover).toHaveBeenCalledOnce();
    expect(store.drafts.get(nextSession)).toMatchObject({
      text: "another draft",
      attachments: [],
    });
  });
});
