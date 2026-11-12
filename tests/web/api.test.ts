// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ApiRequestCancelledError,
  ApiTransportError,
  createApi,
} from "../../src/api";
import { deferred } from "./helpers";

const prompt = {
  operationId: "operation-1",
  authorityId: "authority-1",
  sessionId: "session-1",
  message: "hello",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("prompt delivery transport", () => {
  it("bounds a prompt confirmation even when the request ignores abort", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }),
    );

    const delivery = createApi().prompt(prompt);
    const rejected = expect(delivery).rejects.toMatchObject({
      name: "ApiTransportError",
      outcomeUnknown: true,
      timedOut: true,
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(signal?.aborted).toBe(true);
    await rejected;
  });

  it("keeps a submitted prompt unconfirmed when its receipt read returns 401", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ ...prompt, accepted: false, pending: true }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: "Pairing expired" }, { status: 401 }),
      );
    vi.stubGlobal("fetch", fetch);
    const result = expect(createApi().prompt(prompt)).rejects.toMatchObject({
      status: 401,
      outcomeUnknown: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "/api/prompt/operation-1?authorityId=authority-1",
    );
  });

  it("accepts only matching Host proof of rejection", async () => {
    const headers = {
      "X-Inspire-Authority": prompt.authorityId,
      "X-Inspire-Prompt-Operation": prompt.operationId,
      "X-Inspire-Prompt-Outcome": "rejected",
    };
    const response = (values = headers) =>
      Response.json(
        { error: "Pi refused prompt" },
        { status: 409, headers: values },
      );
    const fetch = vi.fn(() => Promise.resolve(response()));
    vi.stubGlobal("fetch", fetch);
    const api = createApi();
    await expect(api.prompt(prompt)).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      outcomeUnknown: false,
    } satisfies Partial<ApiError>);
    for (const body of [
      { ...prompt, operationId: "another-operation" },
      { ...prompt, authorityId: "another-host" },
    ]) {
      await expect(api.prompt(body)).rejects.toMatchObject({
        outcomeUnknown: true,
      });
    }
    fetch.mockResolvedValueOnce(
      response({ ...headers, "X-Inspire-Prompt-Outcome": "unknown" }),
    );
    await expect(api.prompt(prompt)).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      outcomeUnknown: true,
    });
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
    const rejected = expect(delivery).rejects.toMatchObject({
      name: "AbortError",
      outcomeUnknown: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
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
});

describe("ordinary HTTP observation", () => {
  it("times out an incomplete HTTP refusal without treating the write as rejected", async () => {
    vi.useFakeTimers();
    const response = new Response("", { status: 401 });
    vi.spyOn(response, "json").mockReturnValue(new Promise<never>(() => {}));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    vi.stubGlobal("fetch", fetch);
    const rejected = expect(
      createApi().openSession("s1"),
    ).rejects.toMatchObject({
      name: "ApiTransportError",
      timedOut: true,
      outcomeUnknown: true,
    });
    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each(["invalid JSON", "lost error body", "transport abort"] as const)(
    "keeps creation unconfirmed after %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "invalid JSON") return new Response("not JSON");
          const response = new Response("", { status: 400 });
          const error =
            failure === "transport abort"
              ? new DOMException("Connection lost", "AbortError")
              : new TypeError("Connection lost while reading body");
          vi.spyOn(response, "json").mockRejectedValue(error);
          return response;
        }),
      );
      await expect(createApi().newSession("/workspace")).rejects.toMatchObject({
        name: "ApiTransportError",
        outcomeUnknown: true,
        timedOut: false,
      });
    },
  );

  it.each(["cancelled", "deadline"] as const)(
    "retires a %s write observer before a late 401 can settle it",
    async (reason) => {
      const response = deferred<Response>();
      const fetch = vi.fn(() => response.promise);
      vi.stubGlobal("fetch", fetch);
      const api = createApi();
      const owner = new AbortController();
      const invoke = () =>
        reason === "deadline"
          ? api.openSession("s1", owner.signal)
          : api.navigateBranch(
              { sessionId: "s1", revision: 1, targetId: "t1", mode: "switch" },
              owner.signal,
            );
      const result = expect(invoke()).rejects.toMatchObject(
        reason === "deadline"
          ? { name: "ApiTransportError", outcomeUnknown: true, timedOut: true }
          : { name: "AbortError", outcomeUnknown: true },
      );
      owner.abort(
        reason === "deadline"
          ? new DOMException("Deadline", "TimeoutError")
          : undefined,
      );
      response.resolve(Response.json({ error: "Expired" }, { status: 401 }));
      await result;
      await expect(invoke()).rejects.toMatchObject({
        name: "AbortError",
        outcomeUnknown: false,
      });
      expect(fetch).toHaveBeenCalledOnce();
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
          : api.forkBranch({
              sessionId: "s1",
              viewId: "view-1",
              targetId: "t1",
            })
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await result).toMatchObject({
        timedOut: true,
        outcomeUnknown: true,
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

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

describe("transfer observation", () => {
  // A 1 MiB transfer adds 8 seconds to the documented two-minute overhead.
  const transferBytes = 1_048_576;

  it("allows time for a bounded preview and aborts if the body stalls", async () => {
    vi.useFakeTimers();
    const response = new Response("");
    vi.spyOn(response, "blob").mockReturnValue(new Promise<Blob>(() => {}));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
    vi.stubGlobal("fetch", fetch);
    const settled = vi.fn();
    const reading = createApi().resourceContent("resource", "session", {
      byteLimit: transferBytes,
    });
    void reading.then(settled, settled);
    const rejected = expect(reading).rejects.toMatchObject({
      name: "ApiTransportError",
      timedOut: true,
      outcomeUnknown: false,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.signal?.aborted).toBe(true);
    expect(new Headers(init?.headers).get("Range")).toBe("bytes=0-1048575");
  });

  it("reclaims late upload handles when the owner cancels without resending", async () => {
    vi.useFakeTimers();
    const body = deferred<{ attachments: Array<{ id: string }> }>();
    const response = new Response("");
    vi.spyOn(response, "json").mockReturnValue(body.promise);
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      url === "/api/attachments" ? response : Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetch);
    const owner = new AbortController();
    const file = new File([new Uint8Array(transferBytes)], "upload.txt");
    const settled = vi.fn();
    const uploading = createApi().uploadAttachments([file], owner.signal);
    void uploading.then(settled, settled);
    const rejected = expect(uploading).rejects.toBeInstanceOf(
      ApiRequestCancelledError,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(response.json).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    owner.abort();
    await rejected;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    body.resolve({ attachments: [{ id: "late-handle" }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/attachments", "POST"],
      ["/api/attachments/late-handle", "DELETE"],
    ]);
  });
});

it("preserves explicit settings owners and omits missing ones", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
  vi.stubGlobal("fetch", fetch);
  const api = createApi();
  const cwd = "C:\\Users\\中文 & demo\\project";
  await api.mcpConfig({ cwd });
  await api.modelSettings({ sessionId: "session & one" });
  await api.saveModelPreferences({}, "revision", { defaultModel: null });
  expect(
    fetch.mock.calls.map(([url]) =>
      Object.fromEntries(new URL(String(url), "http://localhost").searchParams),
    ),
  ).toEqual([{ cwd }, { sessionId: "session & one" }, {}]);
});
