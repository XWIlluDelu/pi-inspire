// @vitest-environment node
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("uses a versioned neutral favicon without changing its transparent optical master", async () => {
  const svg = await readFile(
    new URL("../../public/favicon.svg", import.meta.url),
    "utf8",
  );
  const html = await readFile(
    new URL("../../index.html", import.meta.url),
    "utf8",
  );
  expect(html).toContain('href="/favicon.svg?v=3"');
  expect(svg).toContain('viewBox="0 0 16 16"');
  expect(svg).toContain(".reticle { fill: #63676C; }");
  expect(svg).toContain(".reticle { fill: #B9C0C7; }");
  expect(svg).toContain("@media (prefers-color-scheme: dark)");
  expect(svg).not.toMatch(/opacity|<rect|#D95A00|#FF8330/i);
  expect([...svg.matchAll(/ d="([^"]+)"/g)].map((match) => match[1])).toEqual([
    "M11 2h4v4h-2V4h-2zM1 10h2v2h2v2H1z",
    "M7 1h2v3H7zM7 12h2v3H7zM1 7h3v2H1zM12 7h3v2h-3zM7 7h2v2H7z",
  ]);
});

it("does not serve an old shell-cached favicon after its versioned URL changes", async () => {
  const script = await readFile(
    new URL("../../public/service-worker.js", import.meta.url),
    "utf8",
  );
  const listeners = new Map<string, (event: unknown) => void>();
  const fresh = new Response("neutral icon fixture");
  const fetch = vi.fn().mockResolvedValue(fresh);
  const match = vi
    .fn()
    .mockResolvedValue(new Response("old orange icon fixture"));
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
  const request = new Request("https://fixture.test/favicon.svg?v=3");
  const respondWith = vi.fn();
  listeners.get("fetch")!({ request, respondWith });
  expect(fetch).toHaveBeenCalledWith(request);
  expect(match).not.toHaveBeenCalled();
  await expect(respondWith.mock.calls[0]![0]).resolves.toBe(fresh);
});
