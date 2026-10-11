import { expect, test } from "@playwright/test";
import {
  openMockSession,
  pairedPage,
  browserTestToken as token,
} from "./support/navigation";

test("pairing opens the workbench without external requests", async ({
  page,
}) => {
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
});

test("an expired pairing returns to Pair without clearing unrelated cookies", async ({
  page,
}) => {
  await pairedPage(page);
  const origin = new URL(page.url()).origin;
  const accessCookie = (await page.context().cookies(origin)).find((cookie) =>
    cookie.name.startsWith("inspire_access_"),
  );
  expect(accessCookie).toBeDefined();
  await page.context().addCookies([
    {
      name: accessCookie!.name,
      value: "expired-pairing",
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: "unrelated_browser_cookie",
      value: "preserved",
      url: origin,
    },
  ]);

  await page.reload();
  await expect(page.getByLabel("Access token")).toBeVisible();
  const cookiesAfterExpiry = await page.context().cookies(origin);
  expect(
    cookiesAfterExpiry.some((cookie) => cookie.name === accessCookie!.name),
  ).toBe(false);
  expect(
    cookiesAfterExpiry.find(
      (cookie) => cookie.name === "unrelated_browser_cookie",
    )?.value,
  ).toBe("preserved");

  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("main")).toBeVisible();
});
