// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  injectHtmlPreviewCsp,
  MAX_MEDIA_PREVIEW_BYTES,
  NOTEBOOK_PREVIEW_BYTES,
} from "../../src/resource-preview";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteHandler,
  type RouteResponse,
  TEST_SNAPSHOT_DIGEST,
} from "./helpers";

import { baseRoutes, initStore, requestToken } from "./store-fixture";

describe("resource previews", () => {
  const nativeUrl = globalThis.URL;

  beforeEach(() => installFakeWebSocket());
  afterEach(() => {
    // URL is the platform parser used by later tests; object-URL stubs must
    // not replace its constructor beyond the one preview test that owns them.
    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      writable: true,
      value: nativeUrl,
    });
  });

  it("makes sandboxed HTML inert before creating its blob document", () => {
    const html = injectHtmlPreviewCsp(
      '<html><head><base href="https://bad.invalid"><meta http-equiv="refresh" content="0;url=https://bad.invalid"></head><body><script>bad()</script></body></html>',
    );
    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toContain("<base");
    expect(html).not.toMatch(/http-equiv="refresh"/i);
  });

  it("injects the preview CSP into the real head, not a commented-out one", () => {
    const html = injectHtmlPreviewCsp(
      '<!-- <head> --><img src="https://attacker.invalid/pixel">',
    );
    const reparsed = new DOMParser().parseFromString(html, "text/html");
    const meta = reparsed.head.querySelector(
      'meta[http-equiv="Content-Security-Policy"]',
    );
    expect(meta?.getAttribute("content")).toContain("default-src 'none'");
    // The decoy comment must not have swallowed the policy.
    expect(reparsed.head.innerHTML).not.toContain("<!--");
  });

  function resourceRoutes(): RouteHandler {
    return (url, init) => {
      if (url.startsWith("/api/resources/list")) {
        expect(jsonBody(init)).toEqual({ sessionId: "s1" });
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            offset: 0,
            total: 1,
            nextCursor: null,
            resources: [
              {
                key: "file:notes/result.md",
                reference: "notes/result.md",
                label: "notes/result.md",
                source: "link",
              },
            ],
          },
        };
      }
      if (url.startsWith("/api/resources/probe")) {
        const body = jsonBody(init) as { references: string[] };
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: body.references.map((reference) =>
              reference.includes("missing")
                ? {
                    reference,
                    availability: "missing",
                    message: "The referenced file was not found",
                  }
                : reference.includes("outside")
                  ? {
                      reference,
                      availability: "unavailable",
                      message: "The file is outside this session",
                    }
                  : { reference, availability: "available" },
            ),
          },
        };
      }
      if (url.startsWith("/api/resources/resolve")) {
        const body = jsonBody(init) as { reference: string };
        if (body.reference.includes("missing")) {
          return {
            status: 404,
            body: { error: "The referenced file was not found" },
          };
        }
        return {
          body: {
            id: "r1",
            sessionId: "s1",
            viewId: "view-s1",
            reference: body.reference,
            name: body.reference.split("/").pop(),
            mimeType: "text/markdown",
            size: 12, // matches the stubbed "# Notes body" content exactly
            kind: "markdown",
          },
        };
      }
      return baseRoutes(url, init);
    };
  }

  function stubContent(
    text: string,
    headers: Record<string, string> = {},
  ): void {
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/resources/") && url.includes("/content")) {
          return new Response(text, {
            status: 200,
            headers: { "Content-Type": "text/markdown", ...headers },
          });
        }
        return (inner as typeof fetch)(input as RequestInfo | URL, init);
      }),
    );
  }

  it("preflights every loaded reference in bounded batches without selecting or loading content", async () => {
    const batches: string[][] = [];
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/probe")) {
        const body = jsonBody(init) as { references: string[] };
        batches.push(body.references);
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: body.references.map((reference) =>
              reference.includes("missing")
                ? {
                    reference,
                    availability: "missing",
                    message: "The referenced file was not found",
                  }
                : reference.includes("outside")
                  ? {
                      reference,
                      availability: "unavailable",
                      message: "The file is outside this session",
                    }
                  : { reference, availability: "available" },
            ),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const { store } = await initStore();
    const references = Array.from(
      { length: 18 },
      (_, index) => `file-${index}.md`,
    );
    references[16] = "missing/file.md";
    references[17] = "outside/file.md";

    await store.probeResources(references);
    await store.probeResources([...references, "newly-loaded.md"]);
    await store.probeResources([...references, "newly-loaded.md"]);
    expect(batches.map((batch) => batch.length)).toEqual([16, 2, 1]);
    expect(store.getState().selectedResourceReference).toBeNull();
    expect(store.getState().resourcePreview).toBeNull();
    expect(store.getState().resourceAvailability).toMatchObject({
      "missing/file.md": { availability: "missing" },
      "outside/file.md": { availability: "unavailable" },
    });
    expect(store.getState().resourceAvailability["file-0.md"]).toBeUndefined();
  });

  it("keeps probe transport failures visibly unknown and retryable", async () => {
    let fail = true;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/probe")) {
        if (fail) return { status: 503, body: { error: "probe unavailable" } };
        const body = jsonBody(init) as { references: string[] };
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: body.references.map((reference) => ({
              reference,
              availability: "available",
            })),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const { store } = await initStore();

    await store.probeResources(["retry.md"]);
    expect(store.getState().resourceAvailability["retry.md"]).toMatchObject({
      availability: "unknown",
    });
    fail = false;
    await store.probeResources(["retry.md"]);
    expect(store.getState().resourceAvailability["retry.md"]).toBeUndefined();
  });

  it("preserves successful batches when a later availability batch fails", async () => {
    const requests: string[][] = [];
    let failSecondBatch = true;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/probe")) {
        const body = jsonBody(init) as { references: string[] };
        requests.push(body.references);
        if (failSecondBatch && body.references[0] === "file-16.md") {
          return { status: 503, body: { error: "second batch unavailable" } };
        }
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: body.references.map((reference) =>
              reference === "file-0.md"
                ? { reference, availability: "missing", message: "not found" }
                : { reference, availability: "available" },
            ),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const { store } = await initStore();
    const references = Array.from(
      { length: 32 },
      (_, index) => `file-${index}.md`,
    );

    await store.probeResources(references);
    expect(requests.map((batch) => batch.length)).toEqual([16, 16]);
    expect(store.getState().resourceAvailability["file-0.md"]).toMatchObject({
      availability: "missing",
    });
    expect(store.getState().resourceAvailability["file-16.md"]).toMatchObject({
      availability: "unknown",
    });

    failSecondBatch = false;
    await store.probeResources(references);
    expect(requests.map((batch) => batch.length)).toEqual([16, 16, 16]);
    expect(requests[2]).toEqual(references.slice(16));
    expect(store.getState().resourceAvailability["file-0.md"]).toMatchObject({
      availability: "missing",
    });
    expect(store.getState().resourceAvailability["file-16.md"]).toBeUndefined();
  });

  it("explicitly invalidates and re-probes same-revision filesystem standing", async () => {
    let missing = true;
    let probeRequests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/probe")) {
        probeRequests += 1;
        const body = jsonBody(init) as { references: string[] };
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: body.references.map((reference) => ({
              reference,
              availability: missing ? "missing" : "available",
            })),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const { store } = await initStore();

    await store.probeResources(["changing.md"]);
    expect(store.getState().resourceAvailability["changing.md"]).toMatchObject({
      availability: "missing",
    });
    missing = false;
    await store.probeResources(["changing.md"]);
    expect(probeRequests).toBe(1);

    store.cancelResourceProbes(true);
    expect(
      store.getState().resourceAvailability["changing.md"],
    ).toBeUndefined();
    await store.probeResources(["changing.md"]);
    expect(probeRequests).toBe(2);
    expect(
      store.getState().resourceAvailability["changing.md"],
    ).toBeUndefined();
  });

  it("discards probe standing from an obsolete transcript revision", async () => {
    let responseRevision = 1;
    const { promise: gate, resolve: release } = deferred<void>();
    const { promise: requested, resolve: started } = deferred<void>();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/resources/probe")) {
        const body = jsonBody(init) as { references: string[] };
        started();
        await gate;
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: responseRevision,
            results: body.references.map((reference) => ({
              reference,
              availability: "missing",
            })),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const { store, socket } = await initStore();
    const stale = store.probeResources(["missing/file.md"]);
    await requested;
    const currentPage = activeSnapshot().active!.transcriptPage!;
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ transcriptPage: { ...currentPage, revision: 2 } }),
    });
    release();
    await stale;
    expect(
      store.getState().resourceAvailability["missing/file.md"],
    ).toBeUndefined();

    responseRevision = 2;
    await store.probeResources(["missing/file.md"]);
    expect(
      store.getState().resourceAvailability["missing/file.md"],
    ).toMatchObject({ availability: "missing" });
  });

  it("ignores a superseded probe 401 after a fresh pairing succeeds", async () => {
    const oldProbe = deferred<RouteResponse>();
    const { promise: probeStarted, resolve: markProbeStarted } =
      deferred<void>();
    let probeRequests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        const token = requestToken(init);
        return {
          body: bootstrapPayload({
            version: `host-${token}`,
            snapshot: activeSnapshot(),
          }),
        };
      }
      if (url.startsWith("/api/resources/probe")) {
        probeRequests += 1;
        if (probeRequests === 1) {
          markProbeStarted();
          return oldProbe.promise;
        }
        const body = jsonBody(init) as { references: string[] };
        return {
          body: {
            sessionId: "s1",
            viewId: "view-s1",
            revision: 1,
            results: body.references.map((reference) => ({
              reference,
              availability: "available",
            })),
          },
        };
      }
      return resourceRoutes()(url, init);
    });
    const store = new AppStore();
    await store.init("old-token");
    FakeWebSocket.instances.at(-1)!.open();

    const oldRequest = store.probeResources(["stale.md"]);
    await probeStarted;
    await store.init("fresh-token");
    const freshSocket = FakeWebSocket.instances.at(-1)!;
    freshSocket.open();

    oldProbe.resolve({ status: 401, body: { error: "old token expired" } });
    await oldRequest;

    expect(store.getState()).toMatchObject({
      version: "host-fresh-token",
      sessionId: "s1",
      needsToken: false,
      connection: "open",
    });
    expect(freshSocket.url).toBe(
      `ws://localhost:3000/events?snapshot=${TEST_SNAPSHOT_DIGEST}&detail=s1`,
    );
    expect(store.getState().resourceAvailability).toEqual({});
  });

  it("loads a complete notebook within the bounded document-preview range", async () => {
    let range: string | null = null;
    const notebook = JSON.stringify({
      cells: [{ cell_type: "markdown", source: ["# Result"] }],
      metadata: {},
      nbformat: 4,
    });
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          body: {
            id: "notebook",
            sessionId: "s1",
            viewId: "view-s1",
            reference: "analysis.ipynb",
            workspacePath: "analysis.ipynb",
            name: "analysis.ipynb",
            mimeType: "application/x-ipynb+json",
            size: notebook.length,
            kind: "notebook",
          },
        };
      }
      return baseRoutes(url, init);
    });
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/resources/notebook/content")) {
          range = new Headers(init?.headers).get("Range");
          return new Response(notebook, {
            headers: { "Content-Type": "application/x-ipynb+json" },
          });
        }
        return (inner as typeof fetch)(input as RequestInfo | URL, init);
      }),
    );
    const { store } = await initStore();

    await store.openResource("analysis.ipynb");

    expect(range).toBe(`bytes=0-${NOTEBOOK_PREVIEW_BYTES - 1}`);
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      truncated: false,
      text: notebook,
      descriptor: { kind: "notebook" },
    });
  });

  it("clears conversation-derived resource selection on a same-session branch-view boundary", async () => {
    installFetch(resourceRoutes());
    stubContent("# Notes body");
    const { store, socket } = await initStore();
    await store.openResource("notes/result.md");
    expect(store.getState().resourcePreview).toMatchObject({ status: "ready" });

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          sessionId: "s1",
          revision: 1,
          viewId: "view-branch-b",
          effectiveLeafId: "branch-b",
          messages: [],
          hasOlder: false,
          olderCursor: null,
        },
        effectiveLeafId: "branch-b",
      }),
    });

    expect(store.getState().sessionId).toBe("s1");
    expect(store.getState().selectedResourceReference).toBeNull();
    expect(store.getState().resourcePreview).toBeNull();
  });

  it("uses the transfer total for grown and shrunk files instead of resolve metadata", async () => {
    const resolveRoutes = resourceRoutes();
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        const body = jsonBody(init) as { reference: string };
        return {
          body: {
            id: body.reference,
            sessionId: "s1",
            viewId: "view-s1",
            reference: body.reference,
            name: body.reference,
            mimeType: "text/markdown",
            size: 12,
            kind: "markdown",
          },
        };
      }
      return resolveRoutes(url, init);
    });
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/resources/grown.md/content")) {
          return new Response("grown", {
            status: 206,
            headers: {
              "Content-Range": "bytes 0-4/20",
              "Content-Type": "text/markdown",
            },
          });
        }
        if (url.includes("/api/resources/shrunk.md/content")) {
          return new Response("tiny", {
            status: 206,
            headers: {
              "Content-Range": "bytes 0-3/4",
              "Content-Type": "text/markdown",
            },
          });
        }
        return (inner as typeof fetch)(input as RequestInfo | URL, init);
      }),
    );
    const { store } = await initStore();

    await store.openResource("grown.md");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      truncated: true,
      descriptor: { size: 20 },
    });

    await store.openResource("shrunk.md");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      truncated: false,
      descriptor: { size: 4 },
    });
  });

  it("withholds oversized media without starting a content transfer", async () => {
    let contentRequests = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          body: {
            id: "large-image",
            sessionId: "s1",
            viewId: "view-s1",
            reference: "large.png",
            name: "large.png",
            mimeType: "image/png",
            size: MAX_MEDIA_PREVIEW_BYTES + 1,
            kind: "image",
          },
        };
      }
      if (url.includes("/api/resources/") && url.includes("/content")) {
        contentRequests += 1;
        return { body: "should not load" };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await store.openResource("large.png");
    expect(contentRequests).toBe(0);
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      contentUnavailable: "too-large",
    });
  });

  it("range-bounds media and aborts an obsolete transfer", async () => {
    const { promise: started, resolve: firstTransferStarted } =
      deferred<void>();
    let firstSignal: AbortSignal | undefined;
    let secondRange: string | null = null;
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:second"),
      revokeObjectURL: vi.fn(),
    });
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        const body = jsonBody(init) as { reference: string };
        return {
          body: {
            id: body.reference.startsWith("first") ? "first" : "second",
            sessionId: "s1",
            viewId: "view-s1",
            reference: body.reference,
            name: body.reference,
            mimeType: "image/png",
            size: 12,
            kind: "image",
          },
        };
      }
      if (url.includes("/api/resources/first/content")) {
        firstSignal = init.signal ?? undefined;
        firstTransferStarted();
        return new Promise<never>((_resolve, reject) => {
          firstSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (url.includes("/api/resources/second/content")) {
        secondRange = new Headers(init.headers).get("Range");
        return { body: "second image" };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    const first = store.openResource("first.png");
    await started;
    const second = store.openResource("second.png");
    await Promise.all([first, second]);

    expect(firstSignal?.aborted).toBe(true);
    expect(secondRange).toBe(`bytes=0-${MAX_MEDIA_PREVIEW_BYTES}`);
    expect(store.getState().selectedResourceReference).toBe("second.png");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      objectUrl: "blob:second",
    });
  });

  it("loads an embedded transcript image only inside its owning branch view", async () => {
    let range: string | null = null;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        const body = jsonBody(init) as { sessionId: string; reference: string };
        return {
          body: {
            id: "embedded-image",
            sessionId: body.sessionId,
            viewId: "view-s1",
            reference: body.reference,
            name: "Embedded image",
            mimeType: "image/png",
            size: 3,
            kind: "image",
          },
        };
      }
      if (url.includes("/api/resources/embedded-image/content")) {
        range = new Headers(init.headers).get("Range");
        return { body: "png" };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    expect(store.getState().transcriptViewId).toBe("view-s1");

    const blob = await store.loadEmbeddedImage(
      "s1",
      "view-s1",
      "view-s1\u0000projection-1",
      "pi-embedded://4/0",
      new AbortController().signal,
    );
    expect(await blob.text()).toContain("png");
    expect(range).toBe(`bytes=0-${MAX_MEDIA_PREVIEW_BYTES}`);
    await expect(
      store.loadEmbeddedImage(
        "s1",
        "obsolete",
        "obsolete\u0000projection-1",
        "pi-embedded://4/0",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects embedded-image bytes from a replaced projection incarnation", async () => {
    const oldContent = deferred<RouteResponse>();
    const { promise: started, resolve: contentStarted } = deferred<void>();
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        const body = jsonBody(init) as { sessionId: string; reference: string };
        return {
          body: {
            id: "embedded-image",
            sessionId: body.sessionId,
            viewId: "view-s1",
            reference: body.reference,
            name: "Embedded image",
            mimeType: "image/png",
            size: 3,
            kind: "image",
          },
        };
      }
      if (url.includes("/api/resources/embedded-image/content")) {
        contentStarted();
        return oldContent.promise;
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();

    const loading = store.loadEmbeddedImage(
      "s1",
      "view-s1",
      "view-s1\u0000projection-1",
      "pi-embedded://4/0",
      new AbortController().signal,
    );
    await started;
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: { incarnation: "projection-2" },
      }),
    });
    oldContent.resolve({ body: "old" });

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ignores an obsolete embedded-image authorization failure after transport replacement", async () => {
    const oldContent = deferred<RouteResponse>();
    const { promise: started, resolve: contentStarted } = deferred<void>();
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        const body = jsonBody(init) as { sessionId: string; reference: string };
        return {
          body: {
            id: "embedded-image",
            sessionId: body.sessionId,
            viewId: "view-s1",
            reference: body.reference,
            name: "Embedded image",
            mimeType: "image/png",
            size: 3,
            kind: "image",
          },
        };
      }
      if (url.includes("/api/resources/embedded-image/content")) {
        contentStarted();
        return oldContent.promise;
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    const loading = store.loadEmbeddedImage(
      "s1",
      "view-s1",
      "view-s1\u0000projection-1",
      "pi-embedded://4/0",
      new AbortController().signal,
    );
    await started;
    await store.init("fresh");
    oldContent.resolve({ status: 401, body: { error: "expired token" } });

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(store.getState().needsToken).toBe(false);
  });

  it("aborts a pending preview when the session changes", async () => {
    const { promise: started, resolve: transferStarted } = deferred<void>();
    let signal: AbortSignal | undefined;
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          body: {
            id: "owned-by-s1",
            sessionId: "s1",
            viewId: "view-s1",
            reference: "owned.png",
            name: "owned.png",
            mimeType: "image/png",
            size: 12,
            kind: "image",
          },
        };
      }
      if (url.includes("/api/resources/owned-by-s1/content")) {
        signal = init.signal ?? undefined;
        transferStarted();
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();

    const opening = store.openResource("owned.png");
    await started;
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", sessionName: "Other" }),
    });
    await opening;

    expect(signal?.aborted).toBe(true);
    expect(store.getState().resourcePreview).toBeNull();
    expect(store.getState().selectedResourceReference).toBeNull();
  });

  it("surfaces a truthful error state when the host rejects the reference", async () => {
    installFetch(resourceRoutes());
    const { store } = await initStore();

    await store.openResource("missing/file.md");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "error",
      message: "The referenced file was not found",
    });
    // The list stops presenting an unverified mention as an ordinary file…
    expect(
      store.getState().resourceAvailability["missing/file.md"],
    ).toMatchObject({
      reference: "missing/file.md",
      availability: "missing",
    });

    // …but a reference that resolved and then failed to transfer keeps its
    // standing: the file exists, the bytes did not arrive.
    await store.openResource("notes/result.md");
    expect(store.getState().resourcePreview).toMatchObject({ status: "error" });
    expect(
      store.getState().resourceAvailability["missing/file.md"],
    ).toMatchObject({ availability: "missing" });

    // A reference that resolves after all clears its mark.
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          body: {
            id: "r2",
            sessionId: "s1",
            viewId: "view-s1",
            reference: "missing/file.md",
            name: "file.md",
            mimeType: "text/markdown",
            size: 12,
            kind: "markdown",
          },
        };
      }
      return baseRoutes(url, init);
    });
    stubContent("# Notes body");
    await store.openResource("missing/file.md");
    expect(store.getState().resourceAvailability).toEqual({});
  });

  it("offers the host's candidates instead of guessing an ambiguous bare name", async () => {
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          status: 409,
          body: {
            error: '"notes.md" names 2 files in this workspace',
            matches: ["a/notes.md", "b/notes.md"],
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();

    await store.openResource("notes.md");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ambiguous",
      reference: "notes.md",
      matches: ["a/notes.md", "b/notes.md"],
    });
    // An unanswered choice is not missing, but the row can advertise that it
    // needs a location choice before previewing.
    expect(store.getState().resourceAvailability["notes.md"]).toMatchObject({
      availability: "ambiguous",
      matches: ["a/notes.md", "b/notes.md"],
    });
  });

  it("clears the selection and revokes the object URL when the session changes", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => {
        const url = `blob:preview-${created.length}`;
        created.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
    });
    installFetch((url, init) => {
      if (url.startsWith("/api/resources/resolve")) {
        return {
          body: {
            id: "r1",
            sessionId: "s1",
            viewId: "view-s1",
            reference: "chart.png",
            name: "chart.png",
            mimeType: "image/png",
            size: 10,
            kind: "image",
          },
        };
      }
      return baseRoutes(url, init);
    });
    stubContent("fake-image-bytes");
    const { store, socket } = await initStore();

    await store.openResource("chart.png");
    expect(store.getState().resourcePreview).toMatchObject({
      status: "ready",
      objectUrl: "blob:preview-0",
    });
    expect(created).toHaveLength(1);

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", sessionName: "Other" }),
    });
    expect(store.getState().selectedResourceReference).toBeNull();
    expect(store.getState().resourcePreview).toBeNull();
    expect(revoked).toEqual(["blob:preview-0"]);
  });

  it("clears a selected resource when the same view projection is replaced", async () => {
    installFetch(resourceRoutes());
    stubContent("# Notes body");
    const { store, socket } = await initStore();

    await store.openResource("notes/result.md");
    expect(store.getState()).toMatchObject({
      fileBrowserView: "preview",
      selectedResourceReference: "notes/result.md",
      resourcePreview: { status: "ready" },
    });

    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: {
          revision: 2,
          appendFromRevision: 2,
          incarnation: "projection-2",
        },
      }),
    });

    expect(store.getState()).toMatchObject({
      fileBrowserView: "browse",
      selectedResourceReference: null,
      resourcePreview: null,
      resourceAvailability: {},
      resourceWorkspacePaths: {},
    });
  });
});
