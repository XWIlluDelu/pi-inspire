import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./fixtures/host-api.js";

describe("Pending handoff receipts", () => {
  let f: Awaited<ReturnType<typeof hostApiFixture>>;
  beforeEach(async () => {
    f = await hostApiFixture();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await closeHostApiFixture(f);
  });

  it.each(["recover", "abort"] as const)(
    "shares concurrent %s observations and never clears a later queue on retry",
    async (action) => {
      let finish!: (value: { steering: string[]; followUp: string[] }) => void;
      const gate = new Promise<{ steering: string[]; followUp: string[] }>(
        (resolve) => {
          finish = resolve;
        },
      );
      const operation = vi
        .spyOn(f.runtime, action === "recover" ? "recoverPending" : "abort")
        .mockReturnValueOnce(gate);
      const body = {
        sessionId: "mock-active",
        authorityId: f.application.authorityId,
        operationId: randomUUID(),
      };
      const path =
        action === "recover" ? "/api/pending/recover" : "/api/control/abort";
      const post = () =>
        request(f.application.server)
          .post(path)
          .set("Authorization", `Bearer ${token}`)
          .send(body);
      const first = post().then((response) => response);
      await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
      const second = post().then((response) => response);
      finish({ steering: ["original text"], followUp: [] });
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe(200);
      expect(b.body).toEqual(a.body);
      operation.mockResolvedValue({
        steering: ["new queue must remain"],
        followUp: [],
      });
      const reclaimed = await request(f.application.server)
        .get(`/api/pending/operations/${body.operationId}`)
        .set("Authorization", `Bearer ${token}`)
        .query({
          authorityId: body.authorityId,
          sessionId: body.sessionId,
          action,
        })
        .expect(200);
      expect(reclaimed.body).toEqual(a.body);
      expect((await post()).body).toEqual(a.body);
      expect(operation).toHaveBeenCalledOnce();
      for (const changed of [
        { sessionId: "mock-older" },
        { authorityId: randomUUID() },
      ]) {
        await request(f.application.server)
          .post(path)
          .set("Authorization", `Bearer ${token}`)
          .send({ ...body, ...changed })
          .expect(409);
      }
      await request(f.application.server)
        .post(
          action === "recover" ? "/api/control/abort" : "/api/pending/recover",
        )
        .set("Authorization", `Bearer ${token}`)
        .send(body)
        .expect(409);
      expect(operation).toHaveBeenCalledOnce();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 16 * 60_000);
      const retired = await post().expect(409);
      expect(retired.body.code).toBe("PENDING_OPERATION_RESULT_RETIRED");
      expect(operation).toHaveBeenCalledOnce();
    },
  );

  it("never executes a receipt-only lookup or an unauthenticated recovery", async () => {
    const recover = vi.spyOn(f.runtime, "recoverPending");
    const body = {
      authorityId: f.application.authorityId,
      operationId: randomUUID(),
      sessionId: "mock-active",
    };
    await request(f.application.server)
      .post("/api/pending/recover")
      .send(body)
      .expect(401);
    await request(f.application.server)
      .get(`/api/pending/operations/${body.operationId}`)
      .set("Authorization", `Bearer ${token}`)
      .query({
        authorityId: body.authorityId,
        sessionId: body.sessionId,
        action: "recover",
      })
      .expect(409);
    expect(recover).not.toHaveBeenCalled();
  });
});
