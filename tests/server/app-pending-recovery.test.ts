import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestError } from "../../server/request-error.js";
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

  it("retains matched failure proof without executing the failed operation again", async () => {
    const recover = vi
      .spyOn(f.runtime, "recoverPending")
      .mockRejectedValueOnce(new Error("transient failure"));
    const body = {
      sessionId: "mock-active",
      authorityId: f.application.authorityId,
      operationId: randomUUID(),
    };
    const post = () =>
      request(f.application.server)
        .post("/api/pending/recover")
        .set("Authorization", `Bearer ${token}`)
        .send(body);
    const failed = await post().expect(500);
    expect(failed.headers["x-inspire-pending-operation"]).toBe(
      body.operationId,
    );
    expect(failed.headers["x-inspire-pending-outcome"]).toBe("failed");
    recover.mockResolvedValue({ steering: ["new input"], followUp: [] });
    const again = await post().expect(500);
    const observed = await request(f.application.server)
      .get(`/api/pending/operations/${body.operationId}`)
      .set("Authorization", `Bearer ${token}`)
      .query({
        authorityId: body.authorityId,
        sessionId: body.sessionId,
        action: "recover",
      })
      .expect(500);
    expect(again.body).toEqual(failed.body);
    expect(observed.headers["x-inspire-pending-operation"]).toBe(
      body.operationId,
    );
    expect(observed.headers["x-inspire-pending-outcome"]).toBe("failed");
    expect(recover).toHaveBeenCalledOnce();
  });

  it("returns the same recovered image handles to the original prompt observer", async () => {
    const attachments = [
      {
        id: randomUUID(),
        fileName: "held.png",
        mimeType: "image/png",
        kind: "image",
        size: 7,
      },
    ];
    vi.spyOn(f.runtime, "prompt").mockRejectedValue(
      requestError("Returned to composer", 409, {
        code: "PROMPT_RECOVERED",
        recoveredAttachments: attachments,
      }),
    );
    const response = await request(f.application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId: "mock-active",
        message: "caption",
        authorityId: f.application.authorityId,
        operationId: randomUUID(),
      })
      .expect(409);
    expect(response.body).toMatchObject({
      code: "PROMPT_RECOVERED",
      recoveredAttachments: attachments,
    });
  });

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
