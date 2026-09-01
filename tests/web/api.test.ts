// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiTransportError,
  createApi,
  PROMPT_CONFIRMATION_TIMEOUT_MS,
} from "../../src/api";

const prompt = {
  operationId: "operation-1",
  authorityId: "authority-1",
  sessionId: "session-1",
  message: "hello",
};

describe("prompt delivery transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("bounds an unanswered confirmation as an unknown transport outcome", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );

    const delivery = createApi().prompt(prompt);
    const rejected = expect(delivery).rejects.toBeInstanceOf(ApiTransportError);
    await vi.advanceTimersByTimeAsync(PROMPT_CONFIRMATION_TIMEOUT_MS);

    expect(signal?.aborted).toBe(true);
    await rejected;
  });

  it("clears the confirmation bound after an application response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            { accepted: true, historyEntry: null },
            { status: 202 },
          ),
        ),
      ),
    );

    await expect(createApi().prompt(prompt)).resolves.toEqual({
      accepted: true,
      historyEntry: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Pending response contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a malformed management envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            pendingQueues: {
              managementAvailable: true,
              paused: false,
              revision: 1,
              steering: [{ id: "missing-summary-fields" }],
              followUp: [],
            },
          }),
        ),
      ),
    );

    await expect(
      createApi().managePending("session-1", {
        action: "pause",
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(ApiTransportError);
  });
});
