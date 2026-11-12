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
      await expect(authenticatedFetch(url, {}, transport)).rejects.toThrow(
        "outside this origin",
      );
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not dispatch an already-aborted request", async () => {
    const transport = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      authenticatedFetch(
        "/api/health",
        {
          signal: controller.signal,
        },
        transport,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transport).not.toHaveBeenCalled();
  });
});
