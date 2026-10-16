import { expect, test, type WebSocketRoute } from "@playwright/test";
import { pairedPage } from "./support/navigation";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });

for (const width of [1440, 320]) {
  test(`connection feedback stays quiet while reconnecting but warns when offline at ${width}px`, async ({
    page,
  }) => {
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
