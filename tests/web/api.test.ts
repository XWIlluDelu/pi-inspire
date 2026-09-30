// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ApiRequestCancelledError,
  ApiTransportError,
  createApi,
  HTTP_OBSERVATION_TIMEOUT_MS,
  LONG_HTTP_OBSERVATION_TIMEOUT_MS,
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

  it.each([401, 404, 500])(
    "keeps prompt uncertainty when a later observation receives %i",
    async (status) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            Response.json({
              accepted: false,
              pending: true,
              operationId: prompt.operationId,
              authorityId: prompt.authorityId,
            }),
          )
          .mockResolvedValueOnce(
            Response.json(
              { error: "Observation refused" },
              {
                status,
                headers: { "X-Inspire-Authority": prompt.authorityId },
              },
            ),
          ),
      );
      const result = createApi()
        .prompt(prompt)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(250);
      expect(await result).toMatchObject({ status, outcomeUnknown: true });
    },
  );

  it("distinguishes an owned operation rejection from an HTTP observation refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Response.json(
          { error: "Pi refused prompt" },
          {
            status: 409,
            headers: {
              "X-Inspire-Authority": prompt.authorityId,
              "X-Inspire-Prompt-Operation": prompt.operationId,
              "X-Inspire-Prompt-Outcome": "rejected",
            },
          },
        ),
      ),
    );
    await expect(createApi().prompt(prompt)).rejects.toMatchObject({
      outcomeUnknown: false,
    });
    await expect(
      createApi().prompt({ ...prompt, operationId: "another-operation" }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(
      createApi().prompt({ ...prompt, authorityId: "another-host" }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
  });

  it("waits beyond 30s using owned pending receipts without posting the prompt again", async () => {
    vi.useFakeTimers();
    const pending = {
      accepted: false,
      pending: true,
      operationId: prompt.operationId,
      authorityId: prompt.authorityId,
    };
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return Response.json(
        calls < 3 ? pending : { accepted: true, historyEntry: null },
        { status: 202 },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const delivery = createApi().prompt(prompt);
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(delivery).resolves.toEqual({
      accepted: true,
      historyEntry: null,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]).toEqual([
      "/api/prompt",
      expect.objectContaining({ method: "POST", body: JSON.stringify(prompt) }),
    ]);
    for (const call of fetch.mock.calls.slice(1)) {
      expect(call).toEqual([
        "/api/prompt/operation-1?authorityId=authority-1",
        expect.not.objectContaining({ method: "POST" }),
      ]);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels only receipt observation when the owning transport is retired", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () =>
      Response.json({
        accepted: false,
        pending: true,
        operationId: prompt.operationId,
        authorityId: prompt.authorityId,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const delivery = createApi().prompt(prompt, controller.signal);
    const rejected = expect(delivery).rejects.toBeInstanceOf(ApiTransportError);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not poll a pending receipt from another operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          accepted: false,
          pending: true,
          operationId: "another-operation",
          authorityId: prompt.authorityId,
        }),
      ),
    );
    await expect(createApi().prompt(prompt)).rejects.toBeInstanceOf(
      ApiTransportError,
    );
  });

  it("preserves a Host-authored unknown outcome independently of its status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "Unknown", outcomeUnknown: true },
          {
            status: 409,
            headers: { "X-Inspire-Authority": prompt.authorityId },
          },
        ),
      ),
    );
    await expect(createApi().prompt(prompt)).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      authorityId: prompt.authorityId,
      outcomeUnknown: true,
    } satisfies Partial<ApiError>);
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

describe("ordinary HTTP observation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["headers", "body"] as const)(
    "bounds a blackholed read's %s, even if abort is ignored",
    async (phase) => {
      vi.useFakeTimers();
      const never = new Promise<never>(() => {});
      const fetch = vi.fn((_url: unknown, _init?: RequestInit) =>
        phase === "headers"
          ? never
          : Promise.resolve({ ok: true, json: () => never }),
      );
      vi.stubGlobal("fetch", fetch);
      const result = createApi()
        .snapshot("s1")
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(HTTP_OBSERVATION_TIMEOUT_MS);
      expect(await result).toMatchObject({
        name: "ApiTransportError",
        timedOut: true,
        outcomeUnknown: false,
      });
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("reports an unconfirmed write rather than a failed mutation, without replay", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal("fetch", fetch);
    const result = createApi()
      .openSession("s2")
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(HTTP_OBSERVATION_TIMEOUT_MS);
    expect(await result).toMatchObject({
      outcomeUnknown: true,
      timedOut: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["network", "invalid-json"] as const)(
    "keeps a write outcome unknown after %s failure",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "network") throw new TypeError("Network error");
          return new Response("not JSON");
        }),
      );
      await expect(createApi().newSession("/workspace")).rejects.toMatchObject({
        name: "ApiTransportError",
        outcomeUnknown: true,
        timedOut: false,
      });
    },
  );

  it.each(["headers", "error body"] as const)(
    "treats a transport-originated %s abort as uncertainty, not owner cancellation",
    async (phase) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          const loseTransport = () => {
            throw new DOMException("Connection lost", "AbortError");
          };
          if (phase === "headers") loseTransport();
          return { ok: false, status: 401, json: loseTransport };
        }),
      );
      await expect(
        createApi().nativeCommand({ sessionId: "s1", command: "export" }),
      ).rejects.toMatchObject({
        name: "ApiTransportError",
        outcomeUnknown: true,
        timedOut: false,
      });
    },
  );

  it("preserves an explicit shorter observation deadline as uncertainty, not owner cancellation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<never>(() => {})),
    );
    const controller = new AbortController();
    const result = createApi()
      .openSession("s2", controller.signal)
      .catch((error: unknown) => error);
    controller.abort(new DOMException("Deadline", "TimeoutError"));
    expect(await result).toMatchObject({
      name: "ApiTransportError",
      timedOut: true,
      outcomeUnknown: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes owner cancellation from transport uncertainty and never dispatches pre-cancelled work", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal("fetch", fetch);
    const api = createApi();
    const controller = new AbortController();
    const result = api
      .openSession("s2", controller.signal)
      .catch((error: unknown) => error);
    controller.abort();
    expect(await result).toBeInstanceOf(ApiRequestCancelledError);
    expect(await result).toMatchObject({ outcomeUnknown: true });
    await expect(
      api.openSession("s3", controller.signal),
    ).rejects.toMatchObject({
      name: "AbortError",
      outcomeUnknown: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled error body and ignores a late 401 after cancellation", async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const controller = new AbortController();
    const result = createApi()
      .openSession("s2", controller.signal)
      .catch((error: unknown) => error);
    controller.abort();
    finish(Response.json({ error: "Expired" }, { status: 401 }));
    expect(await result).toBeInstanceOf(ApiRequestCancelledError);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: () => new Promise<never>(() => {}),
      })),
    );
    const stalled = createApi()
      .snapshot("s1")
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(HTTP_OBSERVATION_TIMEOUT_MS);
    expect(await stalled).toMatchObject({
      timedOut: true,
      outcomeUnknown: false,
    });
  });

  it.each(["compact", "export", "navigation"] as const)(
    "keeps %s completion-driven beyond 120s, with cancellation and real transport uncertainty",
    async (operation) => {
      vi.useFakeTimers();
      let finish!: (value: Response) => void;
      const fetch = vi.fn(
        (_url: unknown, _init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const api = createApi();
      const invoke = (signal?: AbortSignal) =>
        operation === "navigation"
          ? api.navigateBranch(
              {
                sessionId: "s1",
                revision: 1,
                targetId: "t1",
                mode: "switch",
              },
              signal,
            )
          : api.nativeCommand({ sessionId: "s1", command: operation }, signal);
      const result = invoke();
      const settled = vi.fn();
      void result.then(settled, settled);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(settled).not.toHaveBeenCalled();
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      const response = {
        outcome: "completed",
        details: [{ label: "Path", value: "/tmp/export.html" }],
      };
      finish(Response.json(response));
      await expect(result).resolves.toEqual(response);

      const controller = new AbortController();
      const cancelled = invoke(controller.signal).catch(
        (error: unknown) => error,
      );
      controller.abort();
      expect(await cancelled).toBeInstanceOf(ApiRequestCancelledError);
      expect(await cancelled).toMatchObject({ outcomeUnknown: true });
      finish(Response.json({ error: "Late pairing error" }, { status: 401 }));
      await expect(invoke(controller.signal)).rejects.toMatchObject({
        outcomeUnknown: false,
      });
      fetch.mockRejectedValueOnce(new TypeError("Network lost"));
      await expect(invoke()).rejects.toMatchObject({
        name: "ApiTransportError",
        timedOut: false,
        outcomeUnknown: true,
      });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["create", "fork"] as const)(
    "keeps %s observation bounded without replay",
    async (operation) => {
      vi.useFakeTimers();
      const fetch = vi.fn(() => new Promise<never>(() => {}));
      vi.stubGlobal("fetch", fetch);
      const api = createApi();
      const result = (
        operation === "create"
          ? api.newSession("/workspace")
          : api.forkBranch({ sessionId: "s1", revision: 1, targetId: "t1" })
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(LONG_HTTP_OBSERVATION_TIMEOUT_MS);
      expect(await result).toMatchObject({
        timedOut: true,
        outcomeUnknown: true,
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("does not turn a lost error body into a definitive creation refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => {
          throw new TypeError("Connection lost while reading body");
        },
      })),
    );
    await expect(createApi().newSession("/workspace")).rejects.toMatchObject({
      name: "ApiTransportError",
      phase: "response",
      outcomeUnknown: true,
    });
  });

  it("preserves non-JSON HTTP status and relay markers for ordinary error presentation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>Bad gateway</html>", {
            status: 502,
            headers: { "X-Inspire-Edge": "ssh-reverse" },
          }),
      ),
    );
    await expect(createApi().bootstrap()).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      edge: "ssh-reverse",
      message: "Request failed (502)",
    });
  });
});

describe("host directory browsing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("encodes host-native paths and opts into hidden folders explicitly", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ path: "C:\\", parent: null, dirs: [] }),
    );
    vi.stubGlobal("fetch", fetch);
    const api = createApi("token");
    await api.browseHostDirs();
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/host/dirs");
    const path = "C:\\Users\\中文 & demo\\.project";
    await api.browseHostDirs(path, true);
    const url = new URL(String(fetch.mock.calls[1]?.[0]), "http://localhost");
    expect(url.searchParams.get("path")).toBe(path);
    expect(url.searchParams.get("showHidden")).toBe("1");
    await api.browseHostDirs(undefined, true);
    expect(fetch.mock.calls[2]?.[0]).toBe("/api/host/dirs?showHidden=1");
    await api.browseHostDirs(path, false);
    expect(
      new URL(
        String(fetch.mock.calls[3]?.[0]),
        "http://localhost",
      ).searchParams.has("showHidden"),
    ).toBe(false);
  });
});

describe("Pending clear contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends only the session identity to the explicit clear endpoint", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await expect(createApi().clearPending("session-1")).resolves.toEqual({
      ok: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/pending/clear",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1" }),
      }),
    );
  });
});
