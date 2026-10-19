import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, type Page, test } from "@playwright/test";
import {
  openMockSession,
  pairedPage,
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
}, async ({ page, context }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      externalRequests.push(url.href);
  });
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
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
      keys: Object.keys(identity).sort(),
      extractable: identity.privateKey.extractable,
      exportRejected,
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
      certificate: identity.certificate,
    };
  });
  expect(stored.keys).toEqual(["certificate", "privateKey"]);
  expect(stored.extractable).toBe(false);
  expect(stored.exportRejected).toBe(true);
  expect(JSON.stringify(stored)).not.toContain(token);
  expect(stored.local + stored.session).not.toContain("ib1.access.");
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByLabel("Access token")).toHaveCount(0);
  expect(page.url()).not.toContain("token");
  const tab = await context.newPage();
  await tab.goto(new URL(page.url()).origin);
  await expect(tab.getByRole("main")).toBeVisible();
  await expect(tab.getByLabel("Access token")).toHaveCount(0);
  await tab.close();
});

test("a second localhost port receives no usable credential and cannot read the paired origin key", {
  tag: "@cross-browser",
}, async ({ page, context }) => {
  await pairedPage(page);
  const origin = new URL(page.url()).origin;
  const receivedCookies: string[] = [];
  const foreign = createServer((request, response) => {
    receivedCookies.push(request.headers.cookie ?? "");
    response.setHeader("Content-Type", "text/html");
    response.end("<title>Foreign localhost port</title>");
  });
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  const foreignOrigin = `http://127.0.0.1:${(foreign.address() as AddressInfo).port}`;
  try {
    const tab = await context.newPage();
    await tab.goto(foreignOrigin);
    expect(
      await tab.evaluate(async () =>
        (await indexedDB.databases()).map((database) => database.name),
      ),
    ).not.toContain("inspire-browser-auth");
    expect(receivedCookies.join(";")).not.toContain(token);
    expect(receivedCookies.join(";")).not.toMatch(/inspire_access|ib1\.access/);
    const replay = await page.request.get(`${origin}/api/health`, {
      headers: { Cookie: receivedCookies.join(";") },
    });
    expect(replay.status()).toBe(401);
    // Pairing is independently required on another port even with identical UI.
    await tab.close();
  } finally {
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
});

test("expires only current Host legacy names, and ignores cookie authentication", {
  tag: "@cross-browser",
}, async ({ page, context }) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  // Seed the exact legacy qualified name to exercise migration in Chromium.
  const { createHash } = await import("node:crypto");
  const suffix = createHash("sha256")
    .update(new URL(origin).host)
    .digest("base64url")
    .slice(0, 12);
  const name = `inspire_access_${suffix}`;
  await context.addCookies([
    { name, value: "legacy", url: origin, httpOnly: true },
    { name: "inspire_access", value: "legacy", url: origin, httpOnly: true },
    { name: "inspire_access_other", value: "preserved", url: origin },
    { name: "unrelated_browser_cookie", value: "preserved", url: origin },
  ]);
  await page.reload();
  await expect(page.getByLabel("Access token")).toBeVisible();
  const cookies = await context.cookies(origin);
  expect(
    cookies.some(
      (cookie) => cookie.name === name || cookie.name === "inspire_access",
    ),
  ).toBe(false);
  expect(
    cookies.find((cookie) => cookie.name === "inspire_access_other")?.value,
  ).toBe("preserved");
  expect(
    cookies.find((cookie) => cookie.name === "unrelated_browser_cookie")?.value,
  ).toBe("preserved");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("main")).toBeVisible();
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
    await page.goto("about:blank");
    await openLaunchLink(
      page,
      host.origin + "/#inspire-bootstrap=already-expired",
    );
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

test("direct launch bootstrap is stripped before application requests, one-use, and reloadable", {
  tag: "@cross-browser",
}, async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await openLaunchLink(page, `/?token=${encodeURIComponent(token)}`);
  expect(new URL(page.url()).search).toBe("");
  expect(new URL(page.url()).hash).toBe("");
  expect(requests.slice(1).join("\n")).not.toContain(token);
  expect(requests.join("\n")).not.toContain("inspire-bootstrap");
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
});

test("socket tickets are exact-origin, audience-bound and single-use in Chromium", async ({
  page,
}) => {
  await pairedPage(page);
  // Capture a genuine memory bearer only inside this isolated security test.
  let bearer = "";
  page.on("request", (request) => {
    const value = request.headers().authorization;
    if (value?.startsWith("Bearer ib1.access.")) bearer = value;
  });
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect.poll(() => bearer).not.toBe("");
  const results = await page.evaluate(async (authorization) => {
    const mint = async (audience: string) => {
      const response = await fetch("/api/auth/socket-ticket", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ audience }),
      });
      return (await response.json()).ticket as string;
    };
    const open = (ticket: string) =>
      new Promise<boolean>((resolve) => {
        const socket = new WebSocket(
          `ws://${location.host}/events?ticket=${ticket}`,
        );
        socket.onopen = () => {
          socket.close();
          resolve(true);
        };
        socket.onerror = () => resolve(false);
      });
    const ticket = await mint("events");
    const first = await open(ticket);
    const replay = await open(ticket);
    const wrongAudience = await open(await mint("terminal"));
    return { first, replay, wrongAudience };
  }, bearer);
  expect(results).toEqual({ first: true, replay: false, wrongAudience: false });
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
    const before = snapshots;
    await host.restart();
    await expect
      .poll(() => snapshots, { timeout: 15_000 })
      .toBeGreaterThan(before);
    await expect(page.getByLabel("Access token")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
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
