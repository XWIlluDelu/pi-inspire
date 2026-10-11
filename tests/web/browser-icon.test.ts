// @vitest-environment node
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

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
