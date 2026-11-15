import { expect, test, type WebSocketRoute } from "@playwright/test";
import { BROWSER_UPGRADE_CLOSE } from "../../shared/browser-build.mjs";
import { openFixtureSession, pairedPage } from "./support/navigation";

test.use({
  serviceWorkers: "block",
  contextOptions: { reducedMotion: "reduce" },
});

test("a retired build keeps the open draft and offers manual reload", async ({
  page,
}) => {
  let socket!: WebSocketRoute;
  let connections = 0;
  await page.routeWebSocket(/\/events(?:\?|$)/, (client) => {
    connections++;
    socket = client;
    const server = client.connectToServer();
    server.onMessage((message) => client.send(message));
    client.onMessage((message) => server.send(message));
  });
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Keep this draft across the upgrade");
  const originalConnections = connections;
  await socket.close({ code: BROWSER_UPGRADE_CLOSE, reason: "Reload Inspire" });
  await expect(
    page.getByRole("button", { name: "Reload", exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("Keep this draft across the upgrade");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  expect(connections).toBe(originalConnections);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(input).toHaveValue("Keep this draft across the upgrade");
});

test("initial workspace loading recovers through retry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const catalog = "**/api/sessions?**";
  await page.route(catalog, (route) =>
    route.fulfill({ json: { sessions: [], total: 0, offset: 0, limit: 40 } }),
  );
  await pairedPage(page);
  await expect(page.locator(".welcome")).toBeVisible();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  const empty = page.locator(".nav .empty-state");
  await expect(empty).toContainText("No sessions yet");
  await page
    .getByRole("searchbox", { name: "Search sessions" })
    .fill("no match");
  await expect(empty).toContainText("No sessions found");
  await page.getByRole("button", { name: "Close navigation" }).click();
  await page.unroute(catalog);
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
  await page.setViewportSize({ width: 320, height: 900 });
  let socket!: WebSocketRoute;
  let withheld: WebSocketRoute | undefined;
  let hold = false;
  let offline = false;
  let ready = false;
  await page.routeWebSocket(/\/events(?:\?|$)/, async (client) => {
    socket = client;
    if (offline) return client.close();
    if (hold) {
      withheld = client;
      return;
    }
    const server = client.connectToServer();
    server.onMessage((message) => {
      if (JSON.parse(String(message)).type === "snapshot") ready = true;
      client.send(message);
    });
    client.onMessage((message) => server.send(message));
  });
  await pairedPage(page);
  await expect.poll(() => ready).toBe(true);
  const navigation = page.getByRole("button", {
    name: "Toggle navigation",
    exact: true,
  });
  await expect(navigation).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "First message", exact: true }),
  ).toBeVisible();

  hold = true;
  ready = false;
  await socket.close();
  const topbar = page.locator(".topbar");
  const reconnect = topbar.getByTitle("Reconnecting", { exact: true });
  await expect(reconnect).toBeVisible();
  await expect(reconnect).toHaveAttribute("role", "status");

  const title = /Formula rendering and spectral analysis/;
  await navigation.click();
  const drawer = page.getByRole("dialog", { name: "Sessions", exact: true });
  await expect(drawer).toBeVisible();
  await drawer
    .getByRole("searchbox", { name: "Search sessions" })
    .fill(title.source);
  await drawer
    .locator('[data-session-id="fixture-active"] .nav__row-main')
    .click();
  await expect(topbar.locator(".topbar__title-button")).toHaveText(title);
  await expect(reconnect).toBeVisible();
  expect(await topbar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );

  offline = true;
  await page.context().setOffline(true);
  // Network emulation does not close a fully mocked socket. Close the
  // withheld connection so the app can detect the failed reconnect.
  await withheld?.close();
  const warning = topbar.getByTitle("Device offline", { exact: true });
  await expect(warning).toBeVisible({ timeout: 15_000 });
  await expect(reconnect).toBeHidden();
  await expect(topbar.locator(".topbar__title-button")).toHaveText(title);

  hold = false;
  offline = false;
  await page.context().setOffline(false);
  await expect.poll(() => ready).toBe(true);
  await expect(reconnect).toHaveCount(0);
  await expect(warning).toHaveCount(0);
});
