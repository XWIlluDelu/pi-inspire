import { describe, expect, it, vi } from "vitest";

const { authenticatedFetch } = await vi.importActual<
  typeof import("../../src/browser-auth")
>("../../src/browser-auth");

describe("browser credential transport boundary", () => {
  it("refuses foreign origins, alternate ports and URL userinfo before calling transport", async () => {
    const transport = vi.fn<typeof fetch>();
    for (const url of [
      "https://foreign.invalid/api/health",
      "http://localhost:9999/api/health",
      "http://user@localhost:3000/api/health",
    ]) {
      await expect(
        authenticatedFetch(
          url,
          { headers: { Authorization: "Bearer short-lived" } },
          transport,
        ),
      ).rejects.toThrow("outside this origin");
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("omits cookies, refuses redirects and never retries a mutation after401", async () => {
    const transport = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 401 }),
    );
    const result = await authenticatedFetch(
      "/api/preferences",
      {
        method: "PATCH",
        credentials: "include",
        redirect: "follow",
        headers: { Authorization: "Bearer short-lived" },
        body: "{}",
      },
      transport,
    );
    expect(result.status).toBe(401);
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      "/api/preferences",
      expect.objectContaining({
        method: "PATCH",
        credentials: "omit",
        redirect: "error",
        body: "{}",
      }),
    );
  });

  it("does not dispatch an already-aborted request", async () => {
    const transport = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      authenticatedFetch(
        "/api/health",
        {
          headers: { Authorization: "Bearer short-lived" },
          signal: controller.signal,
        },
        transport,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transport).not.toHaveBeenCalled();
  });
});
