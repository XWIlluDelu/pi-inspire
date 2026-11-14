// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchOperationReceipt } from "../../shared/host-operations";
import {
  type HostRestartRequest,
  restartObservation,
} from "../../shared/host-restart";
import { ApiRequestCancelledError, createApi } from "../../src/api";
import { deferred } from "./helpers";

const prompt = {
  operationId: "operation-1",
  authorityId: "authority-1",
  sessionId: "session-1",
  message: "hello",
};

const receipt = {
  executor: { kind: "host", authorityId: "authority-1" },
  operationId: "operation-1",
  command: "prompt",
};
const receiptPath = "/api/prompt/operation-1?authorityId=authority-1";
const accepted = { ...receipt, state: "completed", result: null };
const pending = { ...receipt, state: "pending" };
const rejection = {
  ...receipt,
  state: "rejected",
  error: { status: 409, message: "Pi refused prompt" },
};

function transport(...replies: Array<Response | Error>) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const reply of replies)
    if (reply instanceof Error) fetch.mockRejectedValueOnce(reply);
    else fetch.mockResolvedValueOnce(reply);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("prompt delivery transport", () => {
  it("bounds each observation even when the transport ignores abort", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      () => new Promise<Response>(() => {}),
    );
    vi.stubGlobal("fetch", fetch);

    const delivery = createApi().prompt(prompt);
    const rejected = expect(delivery).rejects.toMatchObject({
      name: "ApiTransportError",
      outcomeUnknown: true,
      timedOut: true,
    });
    await vi.advanceTimersByTimeAsync(125_000);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(
      true,
    );
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it.each([
    [200, accepted, true],
    [409, { code: "PROMPT_OPERATION_NOT_FOUND", outcomeUnknown: true }, false],
    [401, { error: "Pairing expired" }, false],
  ] as const)(
    "observes the original receipt after a lost or pending POST (%s)",
    async (status, result, relayFailure) => {
      vi.useFakeTimers();
      const fetch = transport(
        status === 401
          ? Response.json(pending)
          : new TypeError("Lost submission response"),
        ...(relayFailure ? [Response.json({}, { status: 503 })] : []),
        Response.json(result, { status }),
      );
      const delivery = createApi().prompt(prompt);
      const outcome =
        status === 200
          ? expect(delivery).resolves.toEqual({
              accepted: true,
              historyEntry: null,
            })
          : expect(delivery).rejects.toMatchObject({
              status,
              outcomeUnknown: true,
              ...(status === 409 ? { code: "PROMPT_OPERATION_NOT_FOUND" } : {}),
            });
      await vi.advanceTimersByTimeAsync(1_500);
      await outcome;
      expect(
        fetch.mock.calls.map(([url, init]) => [url, init?.method]),
      ).toEqual([
        ["/api/prompt", "POST"],
        [receiptPath, undefined],
        ...(relayFailure ? [[receiptPath, undefined]] : []),
      ]);
    },
  );

  it.each([
    [rejection, false],
    [{ ...rejection, state: "unknown" }, true],
    [
      { ...rejection, executor: { kind: "host", authorityId: "another-host" } },
      true,
    ],
    [{ ...accepted, result: {} }, true],
  ] as const)(
    "checks only the original receipt and requires matching rejection proof (%#)",
    async (result, outcomeUnknown) => {
      const fetch = transport(
        Response.json(result, {
          status: result.state === "completed" ? 200 : 409,
        }),
      );
      await expect(createApi().observePrompt(prompt)).rejects.toMatchObject({
        outcomeUnknown,
        ...(result.state === "completed" && { name: "ApiTransportError" }),
        ...(!outcomeUnknown && {
          status: 409,
          message: rejection.error.message,
        }),
      });
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        receiptPath,
        expect.not.objectContaining({ method: "POST" }),
      );
    },
  );

  it("waits beyond 30s using owned pending receipts without posting the prompt again", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return Response.json(calls < 3 ? pending : accepted, { status: 202 });
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
        receiptPath,
        expect.not.objectContaining({ method: "POST" }),
      ]);
    }
  });

  it("cancels only receipt observation when the owning transport is retired", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => Response.json(pending));
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
});

it("matches only a complete receipt from the original executor and operation", () => {
  const unknown = { ...rejection, state: "unknown" };
  for (const value of [pending, accepted, rejection, unknown])
    expect(matchOperationReceipt(value, receipt)).toBe(value);
  for (const value of [
    { ...pending, operationId: "another-operation" },
    { ...accepted, command: "abort" },
    { ...rejection, executor: { ...receipt.executor, extra: "invalid" } },
    {
      ...rejection,
      executor: { ...receipt.executor, authorityId: "another-host" },
    },
    { ...pending, executor: null },
    { ...receipt, state: "completed" },
    { ...unknown, error: { status: "409", message: "unknown" } },
    { ...receipt, state: "expired" },
  ]) {
    expect(matchOperationReceipt(value, receipt)).toBeNull();
  }
});

it("requires a restart receipt to confirm the routed interruption grant", async () => {
  const intent: HostRestartRequest = {
    hostId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    scope: "all-pi",
    interruptWork: true,
    skipAttachedStop: true,
  };
  const operation = {
    id: intent.operationId,
    scope: intent.scope,
    interruptWork: true,
    phase: "submitted",
  } as const;
  const accepted = { ...operation, skipAttachedStop: true } as const;
  transport(
    Response.json(restartObservation(intent, operation)),
    Response.json(restartObservation(intent, accepted)),
  );
  await expect(createApi().restartHost(intent)).rejects.toMatchObject({
    outcomeUnknown: true,
  });
  await expect(createApi().restartHost(intent)).resolves.toEqual(accepted);
});

describe("ordinary HTTP observation", () => {
  it("times out an incomplete HTTP refusal without treating the write as rejected", async () => {
    vi.useFakeTimers();
    const response = new Response("", { status: 401 });
    vi.spyOn(response, "json").mockReturnValue(new Promise<never>(() => {}));
    const fetch = transport(response);
    const rejected = expect(
      createApi().json("openSession", { body: { id: "s1" } }),
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
      await expect(
        createApi().json("newSession", { body: { cwd: "/workspace" } }),
      ).rejects.toMatchObject({
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
          ? api.json("openSession", { body: { id: "s1" } }, owner.signal)
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
          ? api.json("newSession", { body: { cwd: "/workspace" } })
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
    transport(
      new Response("<html>Bad gateway</html>", {
        status: 502,
        headers: { "X-Inspire-Edge": "ssh-reverse" },
      }),
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
    const fetch = transport(response);
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
  const fetch = transport(
    ...Array.from({ length: 3 }, () => Response.json({})),
  );
  const api = createApi();
  const cwd = "C:\\Users\\中文 & demo\\project";
  await api.json("mcpConfig", { query: { cwd } });
  await api.json("modelSettings", { query: { sessionId: "session & one" } });
  await api.json("saveModelPreferences", {
    query: {},
    body: { revision: "revision", patch: { defaultModel: null } },
  });
  expect(
    fetch.mock.calls.map(([url]) =>
      Object.fromEntries(new URL(String(url), "http://localhost").searchParams),
    ),
  ).toEqual([{ cwd }, { sessionId: "session & one" }, {}]);
});
