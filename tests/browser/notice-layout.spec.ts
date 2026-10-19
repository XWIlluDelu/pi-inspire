import { expect, test } from "@playwright/test";
import { routeMockSnapshots } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";

for (const touch of [false, true]) {
  test.describe(touch ? "Touch notices" : "Mouse notices", () => {
    test.use({
      serviceWorkers: "block",
      hasTouch: touch,
      deviceScaleFactor: touch ? 2 : 1,
      contextOptions: { reducedMotion: "reduce" },
    });

    test("wrapped titles stay aligned and feedback yields to dialogs and workspace drawers", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 844 });
      let sessionId: string | null = null;
      const transport = await routeMockSnapshots(page, {
        snapshot: (snapshot) => {
          sessionId = snapshot.active?.sessionId ?? null;
        },
        bootstrap: (data) => {
          data.preferences.theme = touch ? "dark" : "light";
        },
      });
      await page.route("**/api/extension-ui", async (route) => {
        const response = route.request().postDataJSON();
        transport.send({
          type: "extension_ui_remove",
          sessionId,
          id: response.id,
          reason: "answered",
        });
        await route.fulfill({ json: { ok: true } });
      });
      await pairedPage(page);
      await openMockSession(page, /Review extension event lifecycle/);
      const notify = (id: string, message: string) =>
        transport.send({
          type: "extension_ui_request",
          sessionId,
          id,
          method: "notify",
          notifyType: "warning",
          message,
        });
      notify(
        "layout-short",
        "(Files): The selected document is no longer available.",
      );
      notify(
        "layout-long",
        "(Workspace index / remote source synchronization): This operation could not finish. Check the connection and try again.",
      );
      const notices = page.locator(".notice--warning");
      await expect(notices).toHaveCount(2);
      for (const width of [1280, 820, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        const geometry = await notices.evaluateAll((items) =>
          items.map((el) => {
            const title = el.querySelector<HTMLElement>(
              ".notice__title > span",
            )!;
            const label = title.getBoundingClientRect();
            const center =
              label.top + parseFloat(getComputedStyle(title).lineHeight) / 2;
            return {
              textInset:
                el.querySelector(".notice__text")!.getBoundingClientRect()
                  .left - label.left,
              marks: [
                el.querySelector(".notice__title > svg")!,
                el.querySelector(".notice__actions")!,
              ].map((mark) => {
                const box = mark.getBoundingClientRect();
                return (box.top + box.bottom) / 2 - center;
              }),
              target: el
                .querySelector(".notice__dismiss")!
                .getBoundingClientRect().width,
              lines:
                label.height / parseFloat(getComputedStyle(title).lineHeight),
            };
          }),
        );
        for (const notice of geometry) {
          expect(Math.abs(notice.textInset)).toBeLessThan(0.25);
          for (const offset of notice.marks)
            expect(Math.abs(offset)).toBeLessThan(0.25);
          expect(notice.target).toBe(touch ? 32 : 24);
        }
        expect(geometry[1]!.lines).toBeGreaterThan(1.5);
      }

      for (const width of [820, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        for (const kind of ["navigation", "resources"] as const) {
          await page
            .getByRole("button", {
              name:
                kind === "navigation"
                  ? "Toggle navigation"
                  : "Toggle resources panel",
              exact: true,
            })
            .click();
          const drawer = page.getByRole("dialog", {
            name: kind === "navigation" ? "Sessions" : "Context panel",
            exact: true,
          });
          await expect(drawer).toBeVisible();
          const scrim = page.locator(".pane-scrim");
          const noticeLayer = () =>
            page
              .locator(".notices")
              .evaluate((el) => Number(getComputedStyle(el).zIndex));
          await expect
            .poll(noticeLayer)
            .toBeLessThan(
              Number(
                await drawer.evaluate((el) => getComputedStyle(el).zIndex),
              ),
            );
          if (await scrim.count())
            expect(
              Number(
                await page
                  .locator(".notices")
                  .evaluate((el) => getComputedStyle(el).zIndex),
              ),
            ).toBeLessThan(
              Number(await scrim.evaluate((el) => getComputedStyle(el).zIndex)),
            );
          if (kind === "navigation") {
            const search = drawer.getByRole("searchbox", {
              name: "Search sessions",
            });
            await search.click({ trial: true });
            await search.fill("Review");
            await expect(search).toHaveValue("Review");
            await search.fill("");
          } else {
            await drawer
              .getByRole("button", { name: "Show hidden files", exact: true })
              .click({ trial: true });
          }
          // Session search consumes its own Escape; move to the drawer close control.
          if (kind === "navigation")
            await drawer
              .getByRole("button", { name: "Close navigation", exact: true })
              .focus();
          await page.keyboard.press("Escape");
          await expect(drawer).toBeHidden();
          await expect(notices).toHaveCount(2);
          await expect(page.locator(".notices")).toHaveCSS("z-index", "60");
        }
      }

      const title = "Choose how to continue reviewing the workspace";
      const option =
        "Inspect the changed files and preserve all existing interaction behavior while checking longer labels.";
      transport.send({
        type: "extension_ui_request",
        sessionId,
        id: "layout-question",
        method: "select",
        responseRequired: true,
        title,
        options: [
          option,
          option + " Check the narrow layout.",
          "检查界面与文字对齐，并保留当前操作方式。",
        ],
      });
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await expect(dialog).toBeVisible();
      await dialog
        .getByRole("option", { name: option, exact: true })
        .click({ trial: true });
      expect(
        await dialog.locator(".dialog__title").evaluate((el) => {
          const box = el.getBoundingClientRect();
          return !!document
            .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            ?.closest('[role="dialog"]');
        }),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(notices).toHaveCount(2);
    });

    test("overflowing warnings remain readable and operable inside the available viewport", {
      tag: "@platform-ui",
    }, async ({ page, context }) => {
      await page.setViewportSize({ width: 1366, height: 900 });
      let sessionId: string | null = null;
      const transport = await routeMockSnapshots(page, {
        snapshot: (snapshot) => {
          sessionId = snapshot.active?.sessionId ?? null;
        },
        bootstrap: (body) => {
          body.preferences.theme = touch ? "dark" : "light";
        },
      });
      await pairedPage(page);
      await openMockSession(page, /Review extension event lifecycle/);
      const editor = page.getByRole("textbox", {
        name: "Message",
        exact: true,
      });
      const draft = "Keep this draft while reading the notifications.";
      await editor.fill(draft);
      await page.evaluate(() => document.fonts.ready);
      const messages = [
        "(Files): The project directory is temporarily unavailable. Keep the current document open, check that the network volume is mounted, then refresh the files list.",
        "(Extension): A background extension could not reconnect to its local service. The current draft is unchanged. Check the service and retry when it becomes available.",
        "(Export): Could not write the report because the output directory is read-only. Choose another destination or update permissions, then retry. The existing report has not been replaced.",
        "(Terminal): The connection was interrupted. Reconnect after the host is reachable; the current session and message draft are unchanged.",
      ];
      const notify = (id: string, message: string) =>
        transport.send({
          type: "extension_ui_request",
          sessionId,
          id,
          method: "notify",
          notifyType: "warning",
          message,
        });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      messages.forEach((message, index) =>
        notify(`overflow-${index}`, message),
      );
      const stack = page.locator(".notices");
      const notices = stack.locator(".notice");
      await expect(notices).toHaveCount(messages.length);
      await expect(stack).not.toHaveClass(/notices--scrollable/);
      await expect(notices.first()).toHaveCSS("animation-name", "float-in");
      await stack.evaluate((el) =>
        Promise.all(
          el
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished),
        ),
      );
      await expect(stack).not.toHaveClass(/notices--scrollable/);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const normalCard = (await notices.first().boundingBox())!;

      for (const [width, height] of [
        [901, 390],
        [568, 320],
        [320, 420],
      ]) {
        await page.setViewportSize({ width, height });
        await expect(stack).toHaveClass(/notices--scrollable/);
        await expect
          .poll(async () => {
            const bounds = (await stack.boundingBox())!;
            return bounds.y + bounds.height;
          })
          .toBeCloseTo(height - 16, 1);
        const header = (await page.locator("main > .topbar").boundingBox())!;
        const box = (await stack.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(header.y + header.height + 7);
        expect(box.y + box.height).toBeLessThanOrEqual(height - 15);
        expect(
          await stack.evaluate((el) => el.scrollHeight > el.clientHeight),
        ).toBe(true);
        // Ordinary Tab targets bring their complete action row into the scrollport.
        for (const notice of await notices.all()) {
          const close = notice.getByRole("button", {
            name: "Dismiss notification",
          });
          await close.focus();
          await expect(close).toBeFocused();
          await close.click({ trial: true });
          const action = (await close.boundingBox())!;
          expect(action.y).toBeGreaterThanOrEqual(box.y);
          expect(action.y + action.height).toBeLessThanOrEqual(
            box.y + box.height + 0.5,
          );
        }
      }

      // Scrolling the notices must not scroll the transcript underneath.
      const transcript = page.locator(".transcript");
      const transcriptTop = await transcript.evaluate((el) => el.scrollTop);
      await notices
        .first()
        .getByRole("button", { name: "Copy Warning" })
        .focus();
      await page.keyboard.press("PageDown");
      let readingPosition = 0;
      // Keyboard scrolling may settle without a scrollend event. Measure the
      // actual positive reading position and wait until it stops changing.
      await expect
        .poll(async () => {
          const current = await stack.evaluate((el) => el.scrollTop);
          const settled = current > 0 && current === readingPosition;
          readingPosition = current;
          return settled;
        })
        .toBe(true);
      expect(readingPosition).toBeGreaterThan(0);
      expect(await transcript.evaluate((el) => el.scrollTop)).toBe(
        transcriptTop,
      );
      notify("overflow-new", "(Workspace): A separate check could not finish.");
      await expect(notices).toHaveCount(5);
      await expect
        .poll(() => stack.evaluate((el) => el.scrollTop))
        .toBeCloseTo(readingPosition, 0);

      // Reflowing a current banner reduces, rather than overlaps, the notice budget.
      let unavailable = true;
      await page.route("**/api/snapshot**", async (route) => {
        if (unavailable)
          await route.fulfill({
            status: 503,
            json: {
              error:
                "The session snapshot could not be read. Check the host connection and retry.",
            },
          });
        else await route.fallback();
      });
      transport.send({ type: "runtime_ready", sessionId });
      const banner = page.getByRole("main").locator(".banner");
      await expect(banner).toContainText("Failed to refresh session");
      await expect
        .poll(async () => {
          const noticeBox = (await stack.boundingBox())!;
          const bannerBox = (await banner.boundingBox())!;
          return noticeBox.y - bannerBox.y - bannerBox.height;
        })
        .toBeGreaterThanOrEqual(7);
      unavailable = false;
      await banner.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(banner).toHaveCount(0);

      const safeArea = await page.addStyleTag({
        content: ":root { --safe-bottom: 32px; }",
      });
      for (const [width, height] of [
        [1024, 390],
        [568, 320],
      ]) {
        await page.setViewportSize({ width, height });
        await expect
          .poll(async () => {
            const bounds = (await stack.boundingBox())!;
            return bounds.y + bounds.height;
          })
          .toBeCloseTo(height - 32, 1);
      }
      await safeArea.evaluate((el) => el.remove());

      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const copy = notices.last().getByRole("button", { name: "Copy Warning" });
      await copy.focus();
      if (touch) await copy.tap();
      else await copy.click();
      await expect(
        notices.last().getByRole("button", { name: "Warning copied" }),
      ).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        "(Workspace): A separate check could not finish.",
      );
      // Returning to ample height removes clipping and restores the floating card width.
      await page.setViewportSize({ width: 1366, height: 900 });
      await expect(stack).not.toHaveClass(/notices--scrollable/);
      const restoredCard = (await notices.first().boundingBox())!;
      expect(restoredCard.width).toBe(normalCard.width);
      expect(restoredCard.height).toBe(normalCard.height);
      await expect(editor).toHaveValue(draft);
      while (await notices.count())
        await notices
          .last()
          .getByRole("button", { name: "Dismiss notification" })
          .click();
      await expect(stack).toHaveCount(0);

      // One tall warning also scrolls without shrinking its card or losing its end.
      const longMessage =
        "(Diagnostics): " +
        "The operation could not finish; check the service and retry. ".repeat(
          35,
        ) +
        "END OF DIAGNOSTIC";
      notify("overflow-single", longMessage);
      await page.setViewportSize({ width: 320, height: 420 });
      await expect(stack).toHaveClass(/notices--scrollable/);
      await expect(notices).toHaveCount(1);
      expect(
        await notices
          .first()
          .evaluate((el) => el.scrollHeight <= el.clientHeight),
      ).toBe(true);
      await stack.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const ending = await notices.locator(".notice__text").evaluate((el) => {
        const node = el.firstChild!;
        const range = document.createRange();
        range.selectNodeContents(el);
        range.setStart(
          node,
          node.textContent!.length - "END OF DIAGNOSTIC".length,
        );
        const box = range.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      });
      const scrollport = (await stack.boundingBox())!;
      expect(ending.top).toBeGreaterThanOrEqual(scrollport.y);
      expect(ending.bottom).toBeLessThanOrEqual(
        scrollport.y + scrollport.height + 0.5,
      );
      const copyLong = notices.getByRole("button", { name: "Copy Warning" });
      await copyLong.focus();
      await copyLong.click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        longMessage,
      );
      const close = notices
        .first()
        .getByRole("button", { name: "Dismiss notification" });
      await close.focus();
      await close.press("Enter");
      await expect(stack).toHaveCount(0);
      await expect(editor).toHaveValue(draft);
    });
  });
}
