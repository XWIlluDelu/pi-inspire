import { expect, type Page, test } from "@playwright/test";
import { routeSnapshots } from "./support/host-events";
import { openFixtureSession, pairedPage } from "./support/navigation";

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
  return (id: string, message: string) => {
    transport.send({
      type: "extension_ui_request",
      sessionId,
      id,
      method: "notify",
      notifyType: "warning",
      message,
    });
  };
}

test("overflowing warnings keep their reading position, full text and reachable actions", {
  tag: "@platform-ui",
}, async ({ page, context }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const warn = await openNoticeSession(page);
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  const draft = "Keep this draft while reading the notifications.";
  await editor.fill(draft);
  for (const [index, subject] of [
    "Files",
    "Extension",
    "Export",
    "Terminal",
  ].entries())
    warn(
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
  await expect
    .poll(() =>
      transcript.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeLessThan(2);
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
  warn("overflow-new", "A separate check could not finish.");
  await expect(notices).toHaveCount(5);
  await expect
    .poll(() => stack.evaluate((el) => el.scrollTop))
    .toBe(readingPosition);

  const dismiss = notices.getByRole("button", { name: "Dismiss notification" });
  for (let count = 5; count > 0; count--) await dismiss.last().click();
  await expect(stack).toHaveCount(0);

  const ending = "END OF DIAGNOSTIC";
  const longMessage = "The operation could not finish. ".repeat(70) + ending;
  warn("overflow-single", longMessage);
  await expect.poll(overflow).toBeGreaterThan(0);
  await expect
    .poll(() =>
      stack.evaluate((el, length) => {
        el.scrollTop = el.scrollHeight;
        const text = el.querySelector(".notice__text")!;
        const end = document.createRange();
        end.selectNodeContents(text);
        const content = text.lastChild!;
        end.setStart(content, content.textContent!.length - length);
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
