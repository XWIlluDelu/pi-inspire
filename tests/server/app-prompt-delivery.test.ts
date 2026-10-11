import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./fixtures/host-api.js";

describe("HTTP prompt operation ownership", () => {
  let application: Awaited<ReturnType<typeof hostApiFixture>>["application"];
  let runtime: Awaited<ReturnType<typeof hostApiFixture>>["runtime"];
  let baseUrl: Awaited<ReturnType<typeof hostApiFixture>>["baseUrl"];
  let promptDelivery: Awaited<
    ReturnType<typeof hostApiFixture>
  >["promptDelivery"];
  let fixture: Awaited<ReturnType<typeof hostApiFixture>>;
  beforeEach(async () => {
    fixture = await hostApiFixture();
    ({ application, runtime, baseUrl, promptDelivery } = fixture);
  });
  afterEach(async () => closeHostApiFixture(fixture));

  it("deduplicates prompt delivery within one Host authority", async () => {
    const prompt = vi.spyOn(runtime, "prompt").mockResolvedValue({
      text: "deliver once",
      images: [],
      files: [],
    });
    const delivery = promptDelivery({
      sessionId: "mock-active",
      message: "deliver once",
    });
    const first = await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send(delivery)
      .expect(202);
    const duplicate = await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send(delivery)
      .expect(202);
    expect(first.body).toEqual({
      accepted: true,
      historyEntry: { text: "deliver once", images: [], files: [] },
    });
    expect(duplicate.body).toEqual(first.body);
    expect(prompt).toHaveBeenCalledExactlyOnceWith({
      sessionId: "mock-active",
      message: "deliver once",
    });

    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...delivery, message: "changed payload" })
      .expect(409)
      .expect((response) =>
        expect(response.body.code).toBe("PROMPT_OPERATION_MISMATCH"),
      );
    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send({
        ...delivery,
        operationId: randomUUID(),
        authorityId: randomUUID(),
      })
      .expect(409)
      .expect((response) =>
        expect(response.body.code).toBe("HOST_AUTHORITY_CHANGED"),
      );
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("observes a slow prompt by identity without redelivering its payload", async () => {
    let finish!: () => void;
    const prompt = vi.spyOn(runtime, "prompt").mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          finish = () => resolve(null);
        }),
    );
    const observationFixture = await hostApiFixture({
      runtime,
      promptObservationWindowMs: 5,
    });
    const observed = observationFixture.application;
    const delivery = {
      ...promptDelivery({
        sessionId: "mock-active",
        message: "slow synthetic preflight",
      }),
      authorityId: observed.authorityId,
    };
    const poll = () =>
      request(observed.server)
        .get(`/api/prompt/${delivery.operationId}`)
        .query({ authorityId: observed.authorityId })
        .set("Authorization", `Bearer ${token}`);
    try {
      const first = await request(observed.server)
        .post("/api/prompt")
        .set("Authorization", `Bearer ${token}`)
        .send(delivery)
        .expect(202);
      expect(first.body).toEqual({
        accepted: false,
        pending: true,
        authorityId: observed.authorityId,
        operationId: delivery.operationId,
      });
      expect((await poll().expect(202)).body).toEqual(first.body);
      expect(
        (
          await request(observed.server)
            .post("/api/prompt")
            .set("Authorization", `Bearer ${token}`)
            .send(delivery)
            .expect(202)
        ).body,
      ).toEqual(first.body);
      expect(prompt).toHaveBeenCalledTimes(1);
      await request(observed.server)
        .get(`/api/prompt/${delivery.operationId}`)
        .query({ authorityId: observed.authorityId })
        .expect(401);
      await request(observed.server)
        .get(`/api/prompt/${randomUUID()}`)
        .query({ authorityId: observed.authorityId })
        .set("Authorization", `Bearer ${token}`)
        .expect(409)
        .expect(({ body }) => expect(body.outcomeUnknown).toBe(true));
      await request(observed.server)
        .get(`/api/prompt/${delivery.operationId}`)
        .query({ authorityId: randomUUID() })
        .set("Authorization", `Bearer ${token}`)
        .expect(409)
        .expect(({ body }) => expect(body.code).toBe("HOST_AUTHORITY_CHANGED"));
      finish();
      expect((await poll().expect(202)).body).toEqual({
        accepted: true,
        historyEntry: null,
      });
      expect((await poll().expect(202)).body).toEqual({
        accepted: true,
        historyEntry: null,
      });
      expect(prompt).toHaveBeenCalledTimes(1);
    } finally {
      finish?.();
      await closeHostApiFixture(observationFixture);
    }
  });

  it("does not cancel or redeliver a prompt when its HTTP observer disconnects", async () => {
    const abort = vi.spyOn(runtime, "abort");
    const close = vi.spyOn(runtime, "close");
    let finish!: () => void;
    let began!: () => void;
    const entered = new Promise<void>((resolve) => {
      began = resolve;
    });
    const prompt = vi.spyOn(runtime, "prompt").mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          finish = () => resolve(null);
          began();
        }),
    );
    const delivery = promptDelivery({
      sessionId: "mock-active",
      message: "disconnect synthetic observer",
    });
    const observer = new AbortController();
    const response = fetch(`${baseUrl}/api/prompt`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(delivery),
      signal: observer.signal,
    });
    const disconnected = expect(response).rejects.toThrow();
    await entered;
    observer.abort();
    await disconnected;
    expect(abort).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    finish();
    const recovered = await request(application.server)
      .get(`/api/prompt/${delivery.operationId}`)
      .query({ authorityId: application.authorityId })
      .set("Authorization", `Bearer ${token}`)
      .expect(202);
    expect(recovered.body).toEqual({ accepted: true, historyEntry: null });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("replays a retained refusal with operation-owned proof without dispatching again", async () => {
    const prompt = vi
      .spyOn(runtime, "prompt")
      .mockRejectedValue(
        Object.assign(new Error("Synthetic rejection"), { status: 409 }),
      );
    const delivery = promptDelivery({
      sessionId: "mock-active",
      message: "Synthetic refused prompt",
    });
    for (let attempt = 0; attempt < 2; attempt += 1)
      await request(application.server)
        .post("/api/prompt")
        .set("Authorization", `Bearer ${token}`)
        .send(delivery)
        .expect(409)
        .expect("X-Inspire-Authority", application.authorityId)
        .expect("X-Inspire-Prompt-Operation", delivery.operationId)
        .expect("X-Inspire-Prompt-Outcome", "rejected")
        .expect(({ body }) => expect(body.error).toBe("Synthetic rejection"));
    await request(application.server)
      .get(`/api/prompt/${delivery.operationId}`)
      .query({ authorityId: application.authorityId })
      .set("Authorization", `Bearer ${token}`)
      .expect(409)
      .expect("X-Inspire-Prompt-Operation", delivery.operationId)
      .expect("X-Inspire-Prompt-Outcome", "rejected");
    await request(application.server)
      .get(`/api/prompt/${delivery.operationId}`)
      .query({ authorityId: application.authorityId })
      .expect(401)
      .expect(({ headers }) =>
        expect(headers["x-inspire-prompt-outcome"]).toBeUndefined(),
      );
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("retains unknown outcomes for both prompt retry and read-only observation", async () => {
    const prompt = vi.spyOn(runtime, "prompt").mockRejectedValue(
      Object.assign(new Error("Synthetic lost receipt"), {
        code: "PI_RPC_OUTCOME_UNKNOWN",
        status: 504,
        outcomeUnknown: true,
      }),
    );
    const delivery = promptDelivery({
      sessionId: "mock-active",
      message: "unknown synthetic outcome",
    });
    for (let attempt = 0; attempt < 2; attempt += 1)
      await request(application.server)
        .post("/api/prompt")
        .set("Authorization", `Bearer ${token}`)
        .send(delivery)
        .expect(504)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            code: "PI_RPC_OUTCOME_UNKNOWN",
            outcomeUnknown: true,
          }),
        );
    await request(application.server)
      .get(`/api/prompt/${delivery.operationId}`)
      .query({ authorityId: application.authorityId })
      .set("Authorization", `Bearer ${token}`)
      .expect(504)
      .expect("X-Inspire-Prompt-Operation", delivery.operationId)
      .expect("X-Inspire-Prompt-Outcome", "unknown")
      .expect(({ body }) => expect(body.outcomeUnknown).toBe(true));
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("fails closed after a prompt response receipt retires", async () => {
    const prompt = vi.spyOn(runtime, "prompt").mockResolvedValue(null);
    const delivery = promptDelivery({
      sessionId: "mock-active",
      message: "retain the identity",
    });
    await request(application.server)
      .post("/api/prompt")
      .set("Authorization", `Bearer ${token}`)
      .send(delivery)
      .expect(202);

    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 15 * 60 * 1_000 + 1);
    try {
      await request(application.server)
        .post("/api/prompt")
        .set("Authorization", `Bearer ${token}`)
        .send(delivery)
        .expect(409)
        .expect(({ body, headers }) => {
          expect(body).toMatchObject({
            code: "PROMPT_OPERATION_RESULT_RETIRED",
            outcomeUnknown: true,
          });
          expect(headers["x-inspire-prompt-outcome"]).toBeUndefined();
        });
      await request(application.server)
        .get(`/api/prompt/${delivery.operationId}`)
        .query({ authorityId: application.authorityId })
        .set("Authorization", `Bearer ${token}`)
        .expect(409)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            code: "PROMPT_OPERATION_RESULT_RETIRED",
            outcomeUnknown: true,
          }),
        );
    } finally {
      clock.mockRestore();
    }
    expect(prompt).toHaveBeenCalledOnce();
  });
});
