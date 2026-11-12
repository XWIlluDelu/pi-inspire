import { expect, test, type WebSocketRoute } from "@playwright/test";
import { pairedPage } from "./support/navigation";

test.use({
  serviceWorkers: "block",
  contextOptions: { reducedMotion: "reduce" },
});

test("initial workspace loading recovers through retry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairedPage(page);
  await expect(page.locator(".welcome")).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/bootstrap**", async (route) => {
    await gate;
    await route.abort("failed");
  });
  try {
    await page.reload({ waitUntil: "commit" });
    await expect(
      page.getByText("Loading workspace", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".topbar__connection")).toHaveCount(0);
    release();
    await expect(
      page.getByRole("heading", { name: "INSΠRE address not reachable" }),
    ).toBeVisible();
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await page.unroute("**/api/bootstrap**");
    await retry.click();
    await expect(page.locator(".welcome")).toBeVisible();
  } finally {
    release();
  }
});

test("reconnect and offline feedback fit Welcome and a narrow session, then clear on recovery", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
  const topbar = page.locator(".topbar");
  const reconnect = topbar.getByTitle("Reconnecting", { exact: true });
  const loader = reconnect.locator(".pi-loading");
  await expect(reconnect).toBeVisible();
  await expect(reconnect).toHaveAttribute("role", "status");
  await expect(loader).toHaveCount(1);
  const header = (await topbar.boundingBox())!;
  const spinner = (await loader.boundingBox())!;
  expect(
    Math.abs(spinner.y + spinner.height / 2 - header.y - header.height / 2),
  ).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 320, height: 900 });
  const title = /Formula rendering and spectral analysis/;
  await page.locator(".welcome").getByRole("button", { name: title }).click();
  await expect(topbar.locator(".topbar__title-button")).toHaveText(title);
  await expect(reconnect).toBeVisible();
  expect(await topbar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );

  await page.context().setOffline(true);
  const warning = topbar.getByTitle("Device offline", { exact: true });
  await expect(warning).toBeVisible();
  await expect(reconnect).toBeHidden();
  await expect(topbar.locator(".topbar__title-button")).toHaveText(title);

  hold = false;
  await page.context().setOffline(false);
  await expect.poll(() => ready).toBe(true);
  await expect(reconnect).toHaveCount(0);
  await expect(warning).toHaveCount(0);
});
