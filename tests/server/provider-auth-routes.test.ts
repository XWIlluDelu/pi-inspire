import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { registerModelSettingsRoutes } from "../../server/model-settings-routes.js";
import type { ProviderAuthService } from "../../server/provider-auth.js";
import type { RuntimeLike } from "../../server/runtime.js";
import type { ProviderLoginAttempt } from "../../shared/model-settings.js";

function fixture() {
  const states = new Map<string, ProviderLoginAttempt>();
  let sequence = 0;
  const auth = {
    start: (provider: string, type: "api_key" | "oauth") => {
      const state: ProviderLoginAttempt = {
        id: `attempt-${++sequence}`,
        provider,
        type,
        status: "pending",
        events: [],
        prompt: null,
      };
      states.set(state.id, state);
      return state;
    },
    snapshot: vi.fn((id: string) => states.get(id)),
    cancel: vi.fn((id: string) => {
      const state = {
        ...states.get(id)!,
        status: "cancelled" as const,
        prompt: null,
      };
      states.set(id, state);
      return state;
    }),
  };
  const app = express();
  app.use(express.json());
  registerModelSettingsRoutes(app, {
    runtime: {} as RuntimeLike,
    providerAuth: auth as unknown as ProviderAuthService,
  });
  app.use(
    (
      error: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(error.status ?? 500).json({ error: error.message }),
  );
  const post = (body: object) =>
    request(app).post("/api/provider-auth").send(body);
  const start = async (provider = "synthetic") => {
    const response = await post({
      operation: "start",
      provider,
      type: "oauth",
    });
    expect(response.status).toBe(200);
    return response.body.result as ProviderLoginAttempt;
  };
  return { auth, states, post, start };
}

describe("HTTP auth receipt observation", () => {
  it("returns a terminal receipt repeatedly without contacting its settled endpoint", async () => {
    const { auth, states, post, start } = fixture();
    const attempt = await start();
    states.set(attempt.id, {
      ...attempt,
      status: "completed",
      message: "Login complete",
    });
    const first = await post({ operation: "status", id: attempt.id });
    expect(first.status).toBe(200);
    const second = await post({ operation: "status", id: attempt.id });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(auth.snapshot).toHaveBeenCalledTimes(1);
    const cancel = await post({ operation: "cancel", id: attempt.id });
    expect(cancel.body).toEqual(first.body);
    expect(auth.cancel).not.toHaveBeenCalled();
  });
  it("keeps a superseded attempt's cancellation readable by its original observer", async () => {
    const { auth, post, start } = fixture();
    const old = await start();
    const next = await start();
    expect(next.id).not.toBe(old.id);
    for (let read = 0; read < 2; read++) {
      const receipt = await post({ operation: "status", id: old.id });
      expect(receipt.status).toBe(200);
      expect(receipt.body.result.status).toBe("cancelled");
    }
    expect(auth.cancel).toHaveBeenCalledTimes(1);
    expect(
      (await post({ operation: "status", id: next.id })).body.result.status,
    ).toBe("pending");
  });
  it("bounds retained terminal receipts without expiring a still-pending attempt", async () => {
    const { states, post, start } = fixture();
    const pending = await start("still-pending");
    const settled: string[] = [];
    for (let index = 0; index < 20; index++) {
      const attempt = await start(`provider-${index}`);
      states.set(attempt.id, { ...attempt, status: "completed" });
      expect((await post({ operation: "status", id: attempt.id })).status).toBe(
        200,
      );
      settled.push(attempt.id);
    }
    expect((await post({ operation: "status", id: settled[0] })).status).toBe(
      404,
    );
    expect((await post({ operation: "status", id: settled[4] })).status).toBe(
      200,
    );
    expect(
      (await post({ operation: "status", id: settled.at(-1) })).status,
    ).toBe(200);
    expect(
      (await post({ operation: "status", id: pending.id })).body.result.status,
    ).toBe("pending");
  });
});
