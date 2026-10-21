// @vitest-environment node
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it.each([
  "/favicon.svg?v=3",
  "/manifest.webmanifest",
  "/app-icon-192.png?v=7",
  "/app-icon-512.png?v=7",
  "/app-icon-maskable-512.png?v=5",
  "/apple-touch-icon.png?v=5",
])(
  "fetches current browser/PWA metadata instead of shell-cached %s",
  async (path) => {
    const script = await readFile(
      new URL("../../public/service-worker.js", import.meta.url),
      "utf8",
    );
    const listeners = new Map<string, (event: unknown) => void>();
    const fresh = new Response("current metadata fixture");
    const fetch = vi.fn().mockResolvedValue(fresh);
    const match = vi
      .fn()
      .mockResolvedValue(new Response("old metadata fixture"));
    runInNewContext(script, {
      URL,
      Request,
      Response,
      fetch,
      caches: { match },
      self: {
        location: new URL(
          "https://fixture.test/service-worker.js?v=unchanged-entry",
        ),
        addEventListener: (type: string, handler: (event: unknown) => void) =>
          listeners.set(type, handler),
      },
    });
    const request = new Request(`https://fixture.test${path}`);
    const respondWith = vi.fn();
    listeners.get("fetch")!({ request, respondWith });
    expect(fetch).toHaveBeenCalledWith(request);
    expect(match).not.toHaveBeenCalled();
    await expect(respondWith.mock.calls[0]![0]).resolves.toBe(fresh);
  },
);
