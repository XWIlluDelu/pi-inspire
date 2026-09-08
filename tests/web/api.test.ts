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
