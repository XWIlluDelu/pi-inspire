// @vitest-environment jsdom
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHostApiFixture,
  hostApiFixture,
  observeEventSocket,
  token,
} from "../server/fixtures/host-api";
import {
  activeSnapshot,
  installFakeWebSocket,
  installFetch,
  TEST_HOST_AUTHORITY,
} from "../web/helpers";
import { baseRoutes, initStore } from "../web/store-fixture";

describe("addressed snapshot confirmation", () => {
  let f: Awaited<ReturnType<typeof hostApiFixture>>;
  beforeEach(async () => {
    installFakeWebSocket();
    f = await hostApiFixture();
  });
  afterEach(async () => {
    await closeHostApiFixture(f);
  });

  it("accepts the real Host's unchanged B confirmation after its already-sent A detail arrives late", async () => {
    await f.runtime.openSession("mock-active");
    await f.runtime.openSession("mock-older");
    const observed = observeEventSocket(
      `${f.baseUrl.replace("http", "ws")}/events?detail=mock-active`,
    );
    try {
      await vi.waitFor(() =>
        expect({
          frames: observed.frames,
          state: observed.socket.readyState,
        }).toMatchObject({ frames: [{ type: "snapshot" }] }),
      );
      f.runtime.emit("event", {
        type: "message_update",
        sessionId: "mock-active",
        message: {
          role: "assistant",
          timestamp: 1,
          content: [{ type: "text", text: "A fragment in transit" }],
        },
      });
      await vi.waitFor(() =>
        expect(
          observed.frames.some((frame) => frame.type === "message_update"),
        ).toBe(true),
      );
      const oldFrame = observed.frames.find(
        (frame) => frame.type === "message_update",
      )!;
      installFetch(async (url, init) => {
        if (url === "/api/sessions/open") {
          const response = await request(f.application.server)
            .post(url)
            .set("Authorization", `Bearer ${token}`)
            .send(JSON.parse(String(init.body)));
          return {
            status: response.status,
            body: { ...response.body, authorityId: TEST_HOST_AUTHORITY },
          };
        }
        return baseRoutes(url, init);
      });
      const { store, socket } = await initStore();
      await store.openSession("mock-older");
      const interest = JSON.parse(socket.sent.at(-1)!);
      const messages = store.getState().messages;
      const read = vi.spyOn(f.runtime, "snapshot");
      observed.socket.send(
        JSON.stringify({ ...interest, authorityId: f.application.authorityId }),
      );
      await vi.waitFor(() =>
        expect(
          observed.frames.some(
            (frame) => frame.detailRevision === interest.revision,
          ),
        ).toBe(true),
      );
      const confirmation = observed.frames.find(
        (frame) => frame.detailRevision === interest.revision,
      )!;
      expect(read).toHaveBeenCalledWith("mock-older");
      expect(confirmation).toMatchObject({
        unchanged: true,
        snapshotDigest: interest.snapshotDigest,
      });
      expect(confirmation).not.toHaveProperty("data");
      socket.emit(oldFrame);
      expect(store.getState().messages).toEqual(messages);
      socket.emit({ ...confirmation, authorityId: TEST_HOST_AUTHORITY });
      expect(socket.readyState).toBe(1);
      expect(store.getState()).toMatchObject({
        sessionId: "mock-older",
        connection: "open",
      });
    } finally {
      observed.socket.close();
    }
  });

  it.each(["target-changed", "wrong-authority", "wrong-digest"] as const)(
    "still refuses unchanged when %s",
    async (problem) => {
      const digest = "b".repeat(64);
      installFetch((url, init) =>
        url === "/api/sessions/open"
          ? {
              body: {
                ...activeSnapshot({ sessionId: "s2" }),
                authorityId: TEST_HOST_AUTHORITY,
                snapshotDigest: digest,
              },
            }
          : baseRoutes(url, init),
      );
      const { store, socket } = await initStore();
      await store.openSession("s2");
      const interest = JSON.parse(socket.sent.at(-1)!);
      if (problem === "target-changed")
        socket.emit({
          type: "message_update",
          sessionId: "s2",
          message: {
            role: "assistant",
            timestamp: 1,
            content: [{ type: "text", text: "new B fragment" }],
          },
        });
      else
        socket.emit({
          type: "message_update",
          sessionId: "s1",
          message: {
            role: "assistant",
            timestamp: 1,
            content: [{ type: "text", text: "old A fragment" }],
          },
        });
      socket.emit({
        type: "snapshot",
        unchanged: true,
        detailRevision: interest.revision,
        detailSessionId: "s2",
        authorityId:
          problem === "wrong-authority"
            ? "foreign-authority"
            : TEST_HOST_AUTHORITY,
        snapshotDigest: problem === "wrong-digest" ? "c".repeat(64) : digest,
      });
      expect(socket.readyState).toBe(3);
      expect(store.getState().connection).toBe("reconnecting");
    },
  );
});
