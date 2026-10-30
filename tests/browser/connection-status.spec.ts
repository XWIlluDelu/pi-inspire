import { expect, test, type WebSocketRoute } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });

for (const width of [1440, 390]) {
  test(`initial workspace loading avoids duplicate connection feedback at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await pairedPage(page);
    await expect(page.locator(".welcome")).toBeVisible();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/bootstrap**", async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.reload({ waitUntil: "commit" });
      await expect(
        page.getByText("Loading workspace", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".topbar__ident")).toHaveCount(0);
      await expect(page.locator(".deferred-loading .pi-loading")).toHaveCount(
        1,
      );
      await expect(page.locator(".topbar__connection")).toHaveCount(0);
      release();
      await expect(
        page.getByText("Loading workspace", { exact: true }),
      ).toHaveCount(0);
      await expect(page.locator(".welcome")).toBeVisible();
    } finally {
      release();
    }
  });
}

test("initial connection failure keeps its retry action and can recover", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairedPage(page);
  await expect(page.locator(".welcome")).toBeVisible();
  await page.route("**/api/bootstrap**", (route) => route.abort("failed"));
  await page.reload({ waitUntil: "commit" });
  await expect(
    page.getByRole("heading", { name: "INSΠRE address not reachable" }),
  ).toBeVisible();
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeVisible();
  await page.unroute("**/api/bootstrap**");
  await retry.click();
  await expect(page.locator(".welcome")).toBeVisible();
});

for (const width of [1440, 320]) {
  test(`connection feedback stays quiet while reconnecting but warns when offline at ${width}px`, {
    tag: "@cross-browser",
  }, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let socket!: WebSocketRoute;
    let hold = false;
    let ready = false;
    await page.routeWebSocket(/\/events(?:\?|$)/, (client) => {
      socket = client;
      if (hold) return;
      const server = client.connectToServer();
      server.onMessage((message) => {
        if (JSON.parse(String(message)).type === "snapshot") ready = true;
        client.send(message);
      });
      client.onMessage((message) => server.send(message));
    });
    await pairedPage(page);
    await expect.poll(() => ready).toBe(true);
    if (width === 320) {
      await openMockSession(page, /Formula rendering and spectral analysis/);
    }

    hold = true;
    ready = false;
    socket.close();
    const reconnect = page
      .locator(".topbar")
      .getByTitle("Reconnecting", { exact: true });
    await expect(reconnect).toBeVisible();
    await expect(reconnect).toHaveAttribute("role", "status");
    await expect(reconnect.locator(".pi-loading")).toHaveCount(1);
    await expect(reconnect.locator(".chip__label")).toHaveText("Reconnecting");
    expect(
      await reconnect.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          background: style.backgroundColor,
          border: style.borderWidth,
          shadow: style.boxShadow,
        };
      }),
    ).toEqual({
      background: "rgba(0, 0, 0, 0)",
      border: "0px",
      shadow: "none",
    });
    expect(
      await reconnect.evaluate((el) => el.closest("button") !== null),
    ).toBe(false);
    const label = (await reconnect.locator(".chip__label").boundingBox())!;
    expect(label.width > 1).toBe(width > 900);
    const topbar = page.locator(".topbar");
    if (width === 1440) {
      // Welcome has no title baseline; its status still needs a centered slot.
      const header = (await topbar.boundingBox())!;
      const loader = (await reconnect.locator(".pi-loading").boundingBox())!;
      expect(
        Math.abs(loader.y + loader.height / 2 - header.y - header.height / 2),
      ).toBeLessThanOrEqual(0.5);
    } else {
      await expect(page.locator(".topbar__title-button")).toHaveText(
        /Formula rendering and spectral analysis/,
      );
    }
    expect(
      await topbar.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);

    await page.context().setOffline(true);
    const warning = topbar.getByTitle("Device offline", { exact: true });
    await expect(warning).toBeVisible();
    await expect(warning).toHaveClass("chip chip--warning");
    await expect(warning.locator(".pi-loading")).toHaveCount(0);

    hold = false;
    await page.context().setOffline(false);
    await expect.poll(() => ready).toBe(true);
    await expect(reconnect).toHaveCount(0);
    await expect(warning).toHaveCount(0);
  });
}
