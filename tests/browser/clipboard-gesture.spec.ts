import { expect, type Page, test } from "@playwright/test";
import { observeClipboardWrites as observeWrites } from "./support/clipboard";
import { openMockSession, pairedPage } from "./support/navigation";

test.use({
  serviceWorkers: "block",
  reducedMotion: "reduce",
  viewport: { width: 1280, height: 900 },
});

test.beforeEach(async ({ browserName, context }) => {
  // Headless Chromium cannot present its clipboard permission prompt.
  // Firefox/WebKit use the actual gesture boundary without a test grant.
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

async function openHistoryDetail(page: Page) {
  await pairedPage(page);
  await openMockSession(page, /Calibration history fixture/);
  const toggle = page.getByRole("button", {
    name: "Toggle resources panel",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await page.getByRole("tab", { name: "History", exact: true }).click();
  const history = page.getByRole("region", { name: "Conversation history" });
  await history
    .getByRole("searchbox", { name: "Find in history" })
    .fill("Compare the calibration strategies");
  await history
    .getByRole("button", {
      name: /Your input.*Compare the calibration strategies/,
    })
    .click();
  return history;
}

test("slow retained text and saved PNG copy after the gesture expires", {
  tag: "@cross-browser",
}, async ({ page }) => {
  const complete = "Retained content. ".repeat(2500) + "COPY_END";
  let copying = false;
  await page.route("**/api/branches/entry?**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const offset = Number(
      new URL(route.request().url()).searchParams.get("offset") ?? 0,
    );
    if (copying && offset === 0)
      await new Promise((resolve) => setTimeout(resolve, 6100));
    const end = Math.min(offset + 32000, complete.length);
    await route.fulfill({
      response,
      json: {
        ...body,
        text: complete.slice(offset, end),
        totalChars: complete.length,
        nextOffset: end < complete.length ? end : null,
      },
    });
  });
  const history = await openHistoryDetail(page);
  await expect(
    history.getByRole("button", { name: "Read more content" }),
  ).toBeVisible();
  await observeWrites(page);
  const needsGesture = await page.evaluate(async () => {
    try {
      const descriptor = {
        name: "clipboard-write" as PermissionName,
        allowWithoutGesture: true,
      };
      return (
        (await navigator.permissions.query(descriptor)).state !== "granted"
      );
    } catch {
      return true;
    }
  });
  copying = true;
  const started = await page.evaluate(() => performance.now());
  await history
    .getByRole("button", { name: "Copy history entry", exact: true })
    .click();
  await expect(
    history.getByRole("button", { name: "history entry copied", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  const writes = await page.evaluate(() => window.gestureClipboardWrites);
  expect(writes.at(-1)?.text === complete).toBe(true);
  expect(writes.at(-1)?.imageWidth).toBe(720);
  if (needsGesture) expect(writes[0]!.started - started).toBeLessThan(1000);
});

test("Copy last response initiates its text write before a slow Host read", {
  tag: "@cross-browser",
}, async ({ page }) => {
  const complete = "Complete response ".repeat(3000) + "RESPONSE_END";
  await page.route("**/api/transcript/assistant-text?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 6100));
    await route.fulfill({ json: { text: complete } });
  });
  await pairedPage(page);
  await openMockSession(page, /Calibration history fixture/);
  await observeWrites(page);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("/copy");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          (expected) => window.gestureClipboardWrites.at(-1)?.text === expected,
          complete,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(input).toHaveValue("");
  await expect(
    page.getByText(
      "Copied the complete last assistant response to the clipboard.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("leaving a pending History copy does not replace a newer clipboard action", {
  tag: "@cross-browser",
}, async ({ page }) => {
  let copying = false;
  let historyTarget: string | null = null;
  let release: () => void = () => {};
  let began: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    began = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/branches/entry?**", async (route) => {
    const response = await route.fetch();
    const target = new URL(route.request().url()).searchParams.get("targetId");
    if (!copying) historyTarget = target;
    // Response Copy also reads retained entries; hold only the older action
    // so the newer independent copy can finish while it is pending.
    if (copying && target === historyTarget) {
      began();
      await finish;
    }
    await route.fulfill({ response });
  });
  const history = await openHistoryDetail(page);
  await expect(
    history.getByRole("button", { name: "Copy history entry", exact: true }),
  ).toBeVisible();
  await observeWrites(page);
  copying = true;
  await history
    .getByRole("button", { name: "Copy history entry", exact: true })
    .click();
  await pending;
  try {
    const retiredCopy = page.waitForEvent("requestfailed", {
      predicate: (request) => {
        const url = new URL(request.url());
        return (
          url.pathname === "/api/branches/entry" &&
          url.searchParams.get("targetId") === historyTarget
        );
      },
    });
    await history
      .getByRole("button", { name: "Back to history", exact: true })
      .click();
    // Observe retirement before the replacement gesture: even if its held
    // response arrives later, this old read cannot complete a clipboard write.
    await retiredCopy;
    // Earlier suites may leave more of this session's transcript loaded.
    // Copy the known complete response, not whichever assistant row is first.
    await page
      .locator(".turn--assistant")
      .filter({ hasText: "The current calibration run is complete." })
      .getByRole("button", { name: "Copy response", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.gestureClipboardWrites.length))
      .toBe(1);
  } finally {
    release();
  }
  await expect(
    page.getByRole("button", { name: "Back to history", exact: true }),
  ).toHaveCount(0);
  const writes = await page.evaluate(() => window.gestureClipboardWrites);
  expect(writes).toEqual([
    {
      started: expect.any(Number),
      text: expect.stringContaining("The current calibration run is complete."),
      imageWidth: null,
    },
  ]);
});
