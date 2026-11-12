import { expect, type Page, test } from "@playwright/test";
import { routeSnapshots } from "./support/host-events";
import {
  openConversationSearch,
  openFixtureSession,
  pairedPage,
} from "./support/navigation";

test.use({
  serviceWorkers: "block",
  contextOptions: { reducedMotion: "reduce" },
});

async function openNoticeSession(page: Page) {
  let sessionId: string | null = null;
  const transport = await routeSnapshots(page, {
    snapshot: (snapshot) => {
      sessionId = snapshot.active?.sessionId ?? null;
    },
  });
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  return {
    error(path: string, error: string) {
      transport.send({
        type: "extension_error",
        sessionId,
        extensionPath: path,
        event: "session_start",
        error,
      });
    },
    warn(id: string, message: string) {
      transport.send({
        type: "extension_ui_request",
        sessionId,
        id,
        method: "notify",
        notifyType: "warning",
        message,
      });
    },
  };
}

test.describe("touch notices", () => {
  test.use({ hasTouch: true });

  test("a retained error leaves workbench controls usable and can be copied on New", async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    const session = await openNoticeSession(page);
    const path = "/extensions/workspace-bridge/index.ts";
    const error =
      "Cannot connect to the local service. Check the service and retry.";
    session.error(path, error);
    const notice = page.locator(".notice--error");
    await expect(notice).toContainText(error);
    const clearOf = async (selector: string) => {
      await expect
        .poll(() =>
          notice.evaluate((el, selector) => {
            const tools = document
              .querySelector(selector)
              ?.getBoundingClientRect();
            return tools ? el.getBoundingClientRect().top - tools.bottom : -1;
          }, selector),
        )
        .toBeGreaterThanOrEqual(0);
    };
    await clearOf(".transcript-search");
    await page.setViewportSize({ width: 390, height: 640 });
    await page.getByRole("button", { name: "Toggle navigation" }).tap();
    const navigation = page.getByRole("dialog", { name: "Sessions" });
    await navigation
      .getByRole("button", { name: "Settings", exact: true })
      .tap();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await settings.getByRole("button", { name: "Close settings" }).tap();
    if (await navigation.isVisible())
      await navigation.getByRole("button", { name: "Close navigation" }).tap();

    await page.getByRole("button", { name: "Toggle resources panel" }).tap();
    const resources = page.getByRole("dialog", { name: "Context panel" });
    await resources
      .getByRole("button", { name: "Show hidden files" })
      .tap({ trial: true });
    await page.keyboard.press("Escape");
    await expect(resources).toBeHidden();
    await expect(notice).toBeVisible();

    await openConversationSearch(page);
    await clearOf(".transcript-search");
    await page.getByRole("button", { name: "Close conversation search" }).tap();
    await clearOf(".transcript-mobile-toolbar");

    await page
      .getByRole("button", { name: "Toggle navigation", exact: true })
      .tap();
    await page.getByRole("button", { name: "New session", exact: true }).tap();
    await page.setViewportSize({ width: 320, height: 420 });
    const editor = page.getByRole("textbox", {
      name: "First message",
      exact: true,
    });
    const draft = "Keep this draft while reading the error.";
    await editor.fill(draft);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await notice.getByRole("button", { name: "Copy Error" }).tap();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`Extension error in ${path}: ${error}`);
    const dismiss = notice.getByRole("button", {
      name: "Dismiss notification",
    });
    expect((await dismiss.boundingBox())!.height).toBeGreaterThanOrEqual(31.99);
    await dismiss.tap();
    await expect(notice).toHaveCount(0);
    await expect(editor).toHaveValue(draft);
  });
});

test("overflowing warnings keep their reading position, full text and reachable actions", {
  tag: "@platform-ui",
}, async ({ page, context }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const session = await openNoticeSession(page);
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  const draft = "Keep this draft while reading the notifications.";
  await editor.fill(draft);
  for (const [index, subject] of [
    "Files",
    "Extension",
    "Export",
    "Terminal",
  ].entries())
    session.warn(
      `overflow-${index}`,
      `(${subject}): This operation could not finish. Keep the current document open, check that the service is reachable, then try again.`,
    );
  const stack = page.locator(".notices");
  const notices = stack.locator(".notice");
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const overflow = () =>
    stack.evaluate((el) => el.scrollHeight - el.clientHeight);
  await expect(notices).toHaveCount(4);
  await expect.poll(overflow).toBeLessThanOrEqual(1);
  await send.click({ trial: true });

  await page.setViewportSize({ width: 320, height: 420 });
  await expect.poll(overflow).toBeGreaterThan(0);
  await send.click({ trial: true });
  const last = notices
    .last()
    .getByRole("button", { name: "Dismiss notification" });
  await last.focus();
  await expect(last).toBeFocused();
  await last.click({ trial: true });

  // Keyboard scrolling belongs to the notice stack while it has focus.
  const copyWarning = notices
    .first()
    .getByRole("button", { name: "Copy Warning" });
  await copyWarning.focus();
  await expect(copyWarning).toBeFocused();
  await stack.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(() => document.fonts.ready);
  const transcript = page.getByRole("log");
  const transcriptTop = await transcript.evaluate((el) => el.scrollTop);
  await page.keyboard.press("PageDown");
  let readingPosition = 0;
  await expect
    .poll(async () => {
      const current = await stack.evaluate((el) => el.scrollTop);
      const settled = current > 0 && current === readingPosition;
      readingPosition = current;
      return settled;
    })
    .toBe(true);
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollTop))
    .toBe(transcriptTop);
  session.warn("overflow-new", "A separate check could not finish.");
  await expect(notices).toHaveCount(5);
  await expect
    .poll(() => stack.evaluate((el) => el.scrollTop))
    .toBe(readingPosition);

  const safeArea = await page.addStyleTag({
    content: ":root { --safe-bottom: 32px; }",
  });
  await expect
    .poll(async () => {
      const box = (await stack.boundingBox())!;
      return box.y + box.height;
    })
    .toBeLessThanOrEqual(420 - 32);
  await safeArea.evaluate((el) => el.parentNode?.removeChild(el));

  const dismiss = notices.getByRole("button", { name: "Dismiss notification" });
  for (let count = 5; count > 0; count--) await dismiss.last().click();
  await expect(stack).toHaveCount(0);

  const ending = "END OF DIAGNOSTIC";
  const longMessage = "The operation could not finish. ".repeat(70) + ending;
  await page.setViewportSize({ width: 320, height: 420 });
  session.warn("overflow-single", longMessage);
  await expect.poll(overflow).toBeGreaterThan(0);
  await expect
    .poll(() =>
      stack.evaluate((el, length) => {
        el.scrollTop = el.scrollHeight;
        const text = el.querySelector(".notice__text")!;
        const end = document.createRange();
        end.selectNodeContents(text);
        end.setStart(
          text.firstChild!,
          text.firstChild!.textContent!.length - length,
        );
        const box = end.getBoundingClientRect();
        const port = el.getBoundingClientRect();
        return box.top >= port.top && box.bottom <= port.bottom + 1;
      }, ending.length),
    )
    .toBe(true);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await notices.getByRole("button", { name: "Copy Warning" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(longMessage);
  await notices
    .getByRole("button", { name: "Dismiss notification" })
    .press("Enter");
  await expect(stack).toHaveCount(0);
  await expect(editor).toHaveValue(draft);
});
