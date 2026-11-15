import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PROMPT_CHARS } from "../../shared/contracts.js";
import {
  hostReceipt,
  promptFingerprintInput,
} from "../../shared/host-operations.js";
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
    const before = (await runtime.snapshot("fixture-active")).active
      ?.transcriptPage.messages;
    const prompt = vi.spyOn(runtime, "prompt");
    const abort = vi.spyOn(runtime, "abort");
    const send = (body: Parameters<typeof promptDelivery>[0]) =>
      localRequest.post("/api/prompt").send(promptDelivery(body));

    await send({ message: "no target" }).expect(400);
    await localRequest.post("/api/control/abort").send({}).expect(400);
    expect(prompt).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    await send({ sessionId: "never-opened", message: "hello" }).expect(409);
    expect(
      (await runtime.snapshot("fixture-active")).active?.transcriptPage
        .messages,
    ).toEqual(before);

    prompt.mockClear().mockResolvedValue(undefined);
    const delivery = {
      sessionId: "fixture-active",
      message: "\u0000".repeat(MAX_PROMPT_CHARS),
    };
    await send(delivery).expect(202);
    expect(prompt).toHaveBeenCalledExactlyOnceWith(delivery);
  });

  it("observes a single delivery through HTTP disconnect, acceptance, and receipt retirement", async () => {
    const { baseUrl, localRequest, runtime, promptDelivery } = await start(100);
    const entered = deferredSignal();
    const message = "deliver once";
    let finish!: () => void;
    const prompt = vi.spyOn(runtime, "prompt").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve();
          entered.resolve();
        }),
    );
    const delivery = promptDelivery({
      sessionId: "fixture-active",
      message,
    });
    const { operationId, authorityId } = delivery;
    const receipt = `/api/prompt/${operationId}`;
    const post = (body = delivery) =>
      localRequest.post("/api/prompt").send(body);
    const fingerprint = createHash("sha256")
      .update(promptFingerprintInput(delivery))
      .digest("hex");
    const observe = (proof = fingerprint) =>
      localRequest.get(receipt).query({ authorityId, fingerprint: proof });

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
      const identity = hostReceipt("prompt", delivery);
      const pending = { ...identity, state: "pending" };
      expect((await observe().expect(202)).body).toEqual(pending);
      expect((await post().expect(202)).body).toEqual(pending);
      await observe("0".repeat(64))
        .expect(409)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            code: "PROMPT_OPERATION_MISMATCH",
            outcomeUnknown: true,
          }),
        );

      await post({ ...delivery, message: "changed payload" })
        .expect(409)
        .expect(({ body }) =>
          expect(body.code).toBe("PROMPT_OPERATION_MISMATCH"),
        );
      await localRequest
        .get(receipt)
        .query({ authorityId: randomUUID() })
        .expect(409)
        .expect(({ body }) => expect(body.code).toBe("HOST_AUTHORITY_CHANGED"));
      finish();
      const accepted = {
        ...identity,
        state: "completed",
        result: null,
      };
      expect((await observe().expect(202)).body).toEqual(accepted);
      expect((await post().expect(202)).body).toEqual(accepted);

      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + 15 * 60 * 1_000 + 1);
      try {
        for (const retired of [observe(), post()]) {
          await retired.expect(409).expect(({ body }) => {
            expect(body).toMatchObject({
              code: "PROMPT_OPERATION_RESULT_RETIRED",
              outcomeUnknown: true,
            });
            expect(body.executor).toBeUndefined();
          });
        }
      } finally {
        clock.mockRestore();
      }
      expect(prompt).toHaveBeenCalledExactlyOnceWith({
        sessionId: "fixture-active",
        message,
      });
    } finally {
      observer.abort();
      finish?.();
    }
  });

  it("preserves the original unknown result after dispatch", async () => {
    const { runtime, localRequest, promptDelivery } = await start();
    const prompt = vi.spyOn(runtime, "prompt").mockRejectedValue(
      Object.assign(new Error("Pi delivery is unconfirmed"), {
        status: 504,
        code: "PI_RPC_OUTCOME_UNKNOWN",
        outcomeUnknown: true,
      }),
    );
    const delivery = promptDelivery({
      sessionId: "fixture-active",
      message: "send once",
    });
    const expected = {
      ...hostReceipt("prompt", delivery),
      state: "unknown",
      error: {
        status: 504,
        code: "PI_RPC_OUTCOME_UNKNOWN",
        message: "Pi delivery is unconfirmed",
      },
    };
    await localRequest.post("/api/prompt").send(delivery).expect(504, expected);
    await localRequest
      .get(`/api/prompt/${delivery.operationId}`)
      .query({ authorityId: delivery.authorityId })
      .expect(504, expected);
    expect(prompt).toHaveBeenCalledOnce();
  });
});

describe("HTTP Pending recovery and abort ownership", () => {
  it("binds the Return receipt to its action and view", async () => {
    const action = "recover";
    const f = await start();
    const result = { steering: ["original text"], followUp: [] };
    const operation = vi
      .spyOn(f.runtime, "recoverPending")
      .mockResolvedValue(result);
    const body = {
      sessionId: "fixture-active",
      authorityId: f.application.authorityId,
      operationId: randomUUID(),
      expectedViewId: "original-view",
    };
    const path = "/api/pending/recover";
    const post = () => f.localRequest.post(path).send(body);
    const expected = {
      ...hostReceipt(action, body),
      state: "completed",
      result,
    };
    await post().expect(200, expected);
    await f.localRequest
      .post("/api/prompt")
      .send({
        ...body,
        message: "This ID is already owned by a Pending command",
      })
      .expect(409);
    const { operationId, ...query } = body;
    await f.localRequest
      .get(`/api/pending/operations/${operationId}`)
      .query({ ...query, action })
      .expect(200, expected);
    await request(f.application.server).post(path).send(body).expect(401);
    await f.localRequest
      .post(path)
      .send({ ...body, expectedViewId: "another-view" })
      .expect(409);
    await f.localRequest.post("/api/control/abort").send(body).expect(409);
    expect(operation).toHaveBeenCalledExactlyOnceWith(
      body.sessionId,
      body.expectedViewId,
    );
  });
});
