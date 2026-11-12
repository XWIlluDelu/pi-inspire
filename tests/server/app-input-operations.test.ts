import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PROMPT_CHARS } from "../../shared/contracts.js";
import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./fixtures/host-api.js";
import { deferredSignal } from "./fixtures/runtime.js";

let fixture: Awaited<ReturnType<typeof hostApiFixture>> | undefined;

async function start(promptObservationWindowMs?: number) {
  fixture = await hostApiFixture({ promptObservationWindowMs });
  return fixture;
}

afterEach(async () => {
  if (fixture) await closeHostApiFixture(fixture);
  fixture = undefined;
});

describe("HTTP prompt operation ownership", () => {
  it("requires an open explicit target and accepts an escaped prompt at the character limit", async () => {
    const { localRequest, runtime, promptDelivery } = await start();
    await runtime.openSession("fixture-active");
    const before = (await runtime.snapshot()).active?.transcriptPage;
    const prompt = vi.spyOn(runtime, "prompt");
    const abort = vi.spyOn(runtime, "abort");
    const send = (body: Parameters<typeof promptDelivery>[0]) =>
      localRequest.post("/api/prompt").send(promptDelivery(body));

    await send({ message: "no target" }).expect(400);
    await localRequest.post("/api/control/abort").send({}).expect(400);
    expect(prompt).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    await send({ sessionId: "never-opened", message: "hello" }).expect(409);
    expect((await runtime.snapshot()).active?.transcriptPage).toEqual(before);

    prompt.mockClear().mockResolvedValue(null);
    const delivery = {
      sessionId: "fixture-active",
      message: "\u0000".repeat(MAX_PROMPT_CHARS),
    };
    await send(delivery).expect(202);
    expect(prompt).toHaveBeenCalledExactlyOnceWith(delivery);
  });

  it("observes a single delivery through HTTP disconnect, acceptance, and receipt retirement", async () => {
    const { baseUrl, localRequest, runtime, promptDelivery } = await start(100);
    const abort = vi.spyOn(runtime, "abort");
    const close = vi.spyOn(runtime, "close");
    const entered = deferredSignal();
    const historyEntry = { text: "deliver once", images: [], files: [] };
    let finish!: () => void;
    const prompt = vi.spyOn(runtime, "prompt").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(historyEntry);
          entered.resolve();
        }),
    );
    const delivery = promptDelivery({
      sessionId: "fixture-active",
      message: historyEntry.text,
    });
    const { operationId, authorityId } = delivery;
    const receipt = `/api/prompt/${operationId}`;
    const post = (body = delivery) =>
      localRequest.post("/api/prompt").send(body);
    const observe = () => localRequest.get(receipt).query({ authorityId });

    const observer = new AbortController();
    const disconnected = expect(
      fetch(`${baseUrl}/api/prompt`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(delivery),
        signal: observer.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    try {
      await entered.promise;
      observer.abort();
      await disconnected;
      expect(abort).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();

      const pending = {
        accepted: false,
        pending: true,
        operationId,
        authorityId,
      };
      expect((await observe().expect(202)).body).toEqual(pending);
      expect((await post().expect(202)).body).toEqual(pending);

      await post({ ...delivery, message: "changed payload" })
        .expect(409)
        .expect(({ body }) =>
          expect(body.code).toBe("PROMPT_OPERATION_MISMATCH"),
        );
      await post({ ...delivery, authorityId: randomUUID() })
        .expect(409)
        .expect(({ body }) => expect(body.code).toBe("HOST_AUTHORITY_CHANGED"));
      await localRequest
        .get(receipt)
        .query({ authorityId: randomUUID() })
        .expect(409)
        .expect(({ body }) => expect(body.code).toBe("HOST_AUTHORITY_CHANGED"));
      await localRequest
        .get(`/api/prompt/${randomUUID()}`)
        .query({ authorityId })
        .expect(409)
        .expect(({ body }) => expect(body.outcomeUnknown).toBe(true));
      finish();
      const accepted = { accepted: true, historyEntry };
      expect((await observe().expect(202)).body).toEqual(accepted);
      expect((await post().expect(202)).body).toEqual(accepted);

      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + 15 * 60 * 1_000 + 1);
      try {
        for (const retired of [observe(), post()]) {
          await retired.expect(409).expect(({ body, headers }) => {
            expect(body).toMatchObject({
              code: "PROMPT_OPERATION_RESULT_RETIRED",
              outcomeUnknown: true,
            });
            expect(headers["x-inspire-prompt-outcome"]).toBeUndefined();
          });
        }
      } finally {
        clock.mockRestore();
      }
      expect(prompt).toHaveBeenCalledExactlyOnceWith({
        sessionId: "fixture-active",
        message: historyEntry.text,
      });
    } finally {
      observer.abort();
      finish?.();
    }
  });

  it.each([
    { outcome: "rejected", status: 409, details: {} },
    {
      outcome: "unknown",
      status: 504,
      details: { code: "PI_RPC_OUTCOME_UNKNOWN", outcomeUnknown: true },
    },
  ])(
    "retains operation-owned $outcome receipts for reads and retries",
    async ({ outcome, status, details }) => {
      const { application, localRequest, runtime, promptDelivery } =
        await start();
      const error = "Synthetic Pi delivery result";
      const prompt = vi
        .spyOn(runtime, "prompt")
        .mockRejectedValue(
          Object.assign(new Error(error), { status, ...details }),
        );
      const delivery = promptDelivery({
        sessionId: "fixture-active",
        message: "send once",
      });
      const { operationId, authorityId } = delivery;
      const receipt = `/api/prompt/${operationId}`;
      const post = () => localRequest.post("/api/prompt").send(delivery);

      for (const observation of [
        post(),
        post(),
        localRequest.get(receipt).query({ authorityId }),
      ]) {
        await observation
          .expect(status)
          .expect("X-Inspire-Authority", authorityId)
          .expect("X-Inspire-Prompt-Operation", operationId)
          .expect("X-Inspire-Prompt-Outcome", outcome)
          .expect(({ body }) =>
            expect(body).toMatchObject({ error, ...details }),
          );
      }
      await request(application.server)
        .get(receipt)
        .query({ authorityId })
        .expect(401)
        .expect(({ headers }) =>
          expect(headers["x-inspire-prompt-outcome"]).toBeUndefined(),
        );
      expect(prompt).toHaveBeenCalledOnce();
    },
  );
});

describe("HTTP Pending recovery and abort ownership", () => {
  it.each(["recover", "abort"] as const)(
    "shares concurrent %s observations and never clears a later queue on retry",
    async (action) => {
      const f = await start();
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
    },
  );

  it("requires authenticated mutation and retains its failure proof for later observation", async () => {
    const f = await start();
    const recover = vi
      .spyOn(f.runtime, "recoverPending")
      .mockRejectedValueOnce(new Error("transient failure"));
    const body = {
      sessionId: "fixture-active",
      authorityId: f.application.authorityId,
      operationId: randomUUID(),
    };
    const post = () => f.localRequest.post("/api/pending/recover").send(body);
    const observe = () =>
      f.localRequest.get(`/api/pending/operations/${body.operationId}`).query({
        authorityId: body.authorityId,
        sessionId: body.sessionId,
        action: "recover",
      });
    await request(f.application.server)
      .post("/api/pending/recover")
      .send(body)
      .expect(401);
    await observe().expect(409);
    expect(recover).not.toHaveBeenCalled();

    const failure = (observation: ReturnType<typeof post>) =>
      observation
        .expect(500)
        .expect("X-Inspire-Pending-Operation", body.operationId)
        .expect("X-Inspire-Pending-Outcome", "failed");
    const failed = await failure(post());
    recover.mockResolvedValue({ steering: ["new input"], followUp: [] });
    expect((await failure(post())).body).toEqual(failed.body);
    expect((await failure(observe())).body).toEqual(failed.body);
    expect(recover).toHaveBeenCalledOnce();
  });
});
