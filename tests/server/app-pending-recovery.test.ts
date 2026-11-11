import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestError } from "../../server/request-error.js";
import { closeHostApiFixture, hostApiFixture } from "./fixtures/host-api.js";

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
        sessionId: "fixture-active",
        authorityId: f.application.authorityId,
        operationId: randomUUID(),
        expectedViewId: "original-view",
      };
      const path =
        action === "recover" ? "/api/pending/recover" : "/api/control/abort";
      const post = () => f.localRequest.post(path).send(body);
      const first = post().then((response) => response);
      await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
      expect(operation).toHaveBeenCalledWith(
        body.sessionId,
        body.expectedViewId,
      );
      const second = post().then((response) => response);
      finish({ steering: ["original text"], followUp: [] });
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe(200);
      expect(b.body).toEqual(a.body);
      operation.mockResolvedValue({
        steering: ["new queue must remain"],
        followUp: [],
      });
      const reclaimed = await f.localRequest
        .get(`/api/pending/operations/${body.operationId}`)
        .query({
          authorityId: body.authorityId,
          sessionId: body.sessionId,
          expectedViewId: body.expectedViewId,
          action,
        })
        .expect(200);
      expect(reclaimed.body).toEqual(a.body);
      expect((await post()).body).toEqual(a.body);
      expect(operation).toHaveBeenCalledOnce();
      for (const changed of [
        { sessionId: "fixture-older" },
        { authorityId: randomUUID() },
        { expectedViewId: "another-view" },
      ]) {
        await f.localRequest
          .post(path)
          .send({ ...body, ...changed })
          .expect(409);
      }
      await f.localRequest
        .post(
          action === "recover" ? "/api/control/abort" : "/api/pending/recover",
        )
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
      sessionId: "fixture-active",
      authorityId: f.application.authorityId,
      operationId: randomUUID(),
    };
    const post = () => f.localRequest.post("/api/pending/recover").send(body);
    const failed = await post().expect(500);
    expect(failed.headers["x-inspire-pending-operation"]).toBe(
      body.operationId,
    );
    expect(failed.headers["x-inspire-pending-outcome"]).toBe("failed");
    recover.mockResolvedValue({ steering: ["new input"], followUp: [] });
    const again = await post().expect(500);
    const observed = await f.localRequest
      .get(`/api/pending/operations/${body.operationId}`)
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
    const response = await f.localRequest
      .post("/api/prompt")
      .send({
        sessionId: "fixture-active",
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
      sessionId: "fixture-active",
    };
    await request(f.application.server)
      .post("/api/pending/recover")
      .send(body)
      .expect(401);
    await f.localRequest
      .get(`/api/pending/operations/${body.operationId}`)
      .query({
        authorityId: body.authorityId,
        sessionId: body.sessionId,
        action: "recover",
      })
      .expect(409);
    expect(recover).not.toHaveBeenCalled();
  });
});
