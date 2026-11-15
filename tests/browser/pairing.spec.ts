import { expect, type Page, test } from "@playwright/test";
import {
  openFixtureSession,
  browserTestToken as token,
} from "./support/navigation";
import { restartableAuthHost } from "./support/restartable-auth-host";

async function openLaunchLink(page: Page, link: string) {
  // Main can render a loading shell before automatic registration commits
  // its key. An authenticated bootstrap response is the readiness witness.
  const ready = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/bootstrap" &&
      response.status() === 200,
  );
  await page.goto(link);
  await ready;
  await expect(page.getByRole("main")).toBeVisible();
}

test("pairing opens the workbench without external requests, cookies, or persistent bearers", {
  tag: "@cross-browser",
}, async ({ page, context, baseURL }) => {
  await context.addCookies([
    { name: "fixture_cookie", value: "present", url: baseURL },
  ]);
  const bootstrap = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/bootstrap",
  );
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      externalRequests.push(url.href);
  });
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  const accessToken = page.getByLabel("Access token");
  await expect(accessToken).toBeVisible();
  await expect(accessToken).toHaveValue("");
  expect(new URL(page.url()).search).toBe("");
  await accessToken.fill(token);
  await page.getByRole("button", { name: "Pair" }).click();
  const request = await bootstrap;
  expect(await request.headerValue("cookie")).toBeNull();
  expect(await request.headerValue("authorization")).toMatch(
    /^Bearer ib1\.access\./u,
  );
  await openFixtureSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await expect(
    page.getByRole("complementary", { name: "Context panel" }),
  ).toBeVisible();
  expect(externalRequests).toEqual([]);
  expect(
    (await context.cookies()).some((cookie) =>
      cookie.name.startsWith("inspire_access"),
    ),
  ).toBe(false);
  const stored = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("inspire-browser-auth", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const identity = await new Promise<{
      privateKey: CryptoKey;
      certificate: string;
    }>((resolve) => {
      const request = database
        .transaction("identity")
        .objectStore("identity")
        .get("host");
      request.onsuccess = () => resolve(request.result);
    });
    database.close();
    let exportRejected = false;
    try {
      await crypto.subtle.exportKey("jwk", identity.privateKey);
    } catch {
      exportRejected = true;
    }
    return {
      exportRejected,
      storedValues: JSON.stringify([identity, localStorage, sessionStorage]),
    };
  });
  expect(stored.exportRejected).toBe(true);
  expect(stored.storedValues).not.toContain(token);
  expect(stored.storedValues).not.toContain("ib1.access.");
  const tab = await context.newPage();
  await tab.goto(new URL(page.url()).origin);
  await expect(tab.getByRole("main")).toBeVisible();
  await tab.close();
});

test("local one-use launch links preserve existing pairing and repair rotated authority", {
  tag: "@cross-browser",
}, async ({ page, browser }) => {
  const host = await restartableAuthHost(token);
  const pairs: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/pair")
      pairs.push(request.postData()!);
  });
  try {
    const link = host.launchUrl();
    expect(link).not.toContain(token);
    expect(new URL(link).search).toBe("");
    await openLaunchLink(page, link);
    expect(new URL(page.url()).hash).toBe("");
    expect(host.registrations()).toBe(1);
    expect(pairs[0]).not.toContain(token);

    // A successful original registration consumed this exact transfer.
    await page.goto("about:blank");
    await openLaunchLink(page, link);
    expect(host.registrations()).toBe(1);

    const unpaired = await browser.newContext();
    try {
      const other = await unpaired.newPage();
      await other.goto(link);
      await expect(other.getByLabel("Access token")).toBeVisible();
      await expect(other.getByRole("main")).toHaveCount(0);
    } finally {
      await unpaired.close();
    }

    await host.restart("rotated-fixture-authority");
    await page.goto("about:blank");
    await openLaunchLink(page, host.launchUrl());
    // The deliberately unpaired context attempted one spent transfer too.
    expect(host.registrations()).toBe(3);
    await page.goto("about:blank");
    await openLaunchLink(page, host.origin);
    expect(host.registrations()).toBe(3);
  } finally {
    await host.close();
  }
});

test("independent Host ports require their own pairing; restart reconnects and rotation returns to Pair", {
  tag: "@cross-browser",
}, async ({ page, context }) => {
  const host = await restartableAuthHost(token);
  const other = await restartableAuthHost(token);
  let snapshots = 0;
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => {
      if (
        typeof frame.payload === "string" &&
        frame.payload.includes('"type":"snapshot"')
      )
        snapshots++;
    }),
  );
  try {
    await page.goto(host.origin);
    await page.getByLabel("Access token").fill(token);
    await page.getByRole("button", { name: "Pair" }).click();
    await expect(page.getByRole("main")).toBeVisible();
    await expect.poll(() => snapshots).toBeGreaterThan(0);
    const tab = await context.newPage();
    await tab.goto(other.origin);
    await expect(tab.getByLabel("Access token")).toBeVisible();
    await tab.getByLabel("Access token").fill(token);
    await tab.getByRole("button", { name: "Pair" }).click();
    await expect(tab.getByRole("main")).toBeVisible();
    await page.bringToFront();
    const before = snapshots;
    await host.restart();
    await expect
      .poll(() => snapshots, { timeout: 15_000 })
      .toBeGreaterThan(before);
    await expect(page.getByLabel("Access token")).toHaveCount(0);
    await host.restart("rotated-test-master");
    await expect(page.getByLabel("Access token")).toBeVisible({
      timeout: 15_000,
    });
    await tab.reload();
    await expect(tab.getByRole("main")).toBeVisible();
    await page.getByLabel("Access token").fill("rotated-test-master");
    await page.getByRole("button", { name: "Pair" }).click();
    await expect(page.getByRole("main")).toBeVisible();
  } finally {
    // Stop the owned listeners first; the test context then closes both pages.
    await host.close();
    await other.close();
  }
});

test("unsupported origin storage reports a useful Pair error without falling back to cookies", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "indexedDB", { value: undefined }),
  );
  await page.goto("/");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("alert")).toContainText("IndexedDB");
  await expect(page.getByRole("main")).toHaveCount(0);
  expect(
    (await page.context().cookies()).some((cookie) =>
      cookie.name.startsWith("inspire_access"),
    ),
  ).toBe(false);
});
