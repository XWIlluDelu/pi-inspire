import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { openCommandPalette } from "./support/navigation";

test.use({ serviceWorkers: "block" });

async function chooseSource(page: Page) {
  const toggle = page.getByRole("button", {
    name: "Toggle navigation",
    exact: true,
  });
  if (
    (await toggle.getAttribute("aria-expanded")) === "false" ||
    (await page.locator(".nav--rail").count())
  )
    await toggle.click();
  await page
    .locator(".nav__row-main")
    .filter({ hasText: "Calibration history fixture" })
    .click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
}

async function openHistory(page: Page) {
  const toggle = page.getByRole("button", {
    name: "Toggle resources panel",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  const history = page.getByRole("region", { name: "Conversation history" });
  await expect(history).toBeVisible();
  return history;
}

async function connectCalibration(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByLabel("Access token").fill("inspire-browser-test-token");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await chooseSource(page);
}

for (const touch of [false, true]) {
  const size = touch ? "narrow" : "desktop";
  test.describe(`${size} History and Clone`, () => {
    test.use({
      viewport: touch
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      hasTouch: touch,
    });
    test("Fork restores saved images for preview, editing and explicit resend", async ({
      page,
    }) => {
      await connectCalibration(page);
      const composer = page.getByRole("form", { name: "Message composer" });
      const input = composer.getByRole("textbox", {
        name: "Message",
        exact: true,
      });
      await input.fill("Keep this source draft");
      const history = await openHistory(page);
      await history
        .getByRole("searchbox", { name: "Find in history" })
        .fill("Compare the calibration strategies");
      await history
        .getByRole("button", {
          name: /Your input.*Compare the calibration strategies/,
        })
        .click();
      const response = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/branches/fork",
      );
      await history
        .getByRole("button", { name: "Fork to new session", exact: true })
        .click();
      const forked = await (await response).json();
      expect(forked.editorAttachments).toHaveLength(1);
      expect(forked.editorText).toContain("Compare the calibration strategies");
      await expect(input).toHaveValue(forked.editorText);
      const restored = composer.getByRole("button", {
        name: "Preview attached image",
      });
      await expect(restored).toHaveCount(1);
      await expect(restored.locator("img")).toHaveJSProperty(
        "naturalWidth",
        720,
      );
      await restored.click();
      const viewer = page.getByRole("dialog", { name: "Image preview" });
      await expect(viewer).toBeVisible();
      await viewer.getByRole("button", { name: "Close image preview" }).click();

      // New uploads and restored images share removal and submission behavior.
      await composer
        .locator('input[type="file"][aria-label="Attach files"]')
        .setInputFiles(
          "tests/browser/fixtures/file-previews/training curve.png",
        );
      await expect(restored).toHaveCount(2);
      await composer
        .getByRole("button", { name: "Remove attached image" })
        .last()
        .click();
      await expect(restored).toHaveCount(1);
      await input.fill("Compare the saved image again");
      await page.screenshot({
        path: `output/playwright/history/${size}-fork-image-draft.png`,
      });
      const prompt = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/prompt",
      );
      await composer
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      expect((await prompt).postDataJSON()).toMatchObject({
        sessionId: forked.sessionId,
        message: "Compare the saved image again",
        attachmentIds: [forked.editorAttachments[0].id],
      });
      await expect(restored).toHaveCount(0);
      await expect(input).toHaveValue("");
    });

    test("retries a History image locally and opens local references in the authorized session reader", async ({
      page,
    }) => {
      await connectCalibration(page);
      let imageAvailable = false;
      const imageRequests: string[] = [];
      let entryRequests = 0;
      await page.route("**/api/branches/entry?**", async (route) => {
        entryRequests++;
        const response = await route.fetch();
        const body = await response.json();
        body.text =
          "Compare the calibration strategies. Read `README.md` or [the project document](README.md); see [external docs](https://example.com/docs).";
        body.nextOffset = null;
        await route.fulfill({ response, json: body });
      });
      await page.route("**/api/branches/image?**", async (route) => {
        imageRequests.push(route.request().url());
        // Fail the selected resource, not an arbitrary first request that a
        // retired effect may abort before it reaches the browser.
        if (!imageAvailable)
          await route.fulfill({
            status: 503,
            json: { error: "Temporary image failure" },
          });
        else await route.continue();
      });
      const selectInput = async () => {
        const history = await openHistory(page);
        await history
          .getByRole("searchbox", { name: "Find in history" })
          .fill("Compare the calibration strategies");
        await history
          .getByRole("button", {
            name: /Your input.*Compare the calibration strategies/,
          })
          .click();
        return history;
      };
      let history = await selectInput();
      const retryImage = history.getByRole("button", {
        name: "Retry image",
        exact: true,
      });
      await expect(retryImage).toBeVisible();
      const failedReads = imageRequests.length;
      imageAvailable = true;
      await retryImage.click();
      const image = history.getByRole("button", {
        name: "Preview image in this history entry",
      });
      await expect
        .poll(() =>
          image
            .locator("img")
            .evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      expect(imageRequests.length).toBeGreaterThan(failedReads);
      expect(new Set(imageRequests).size).toBe(1);
      expect(entryRequests).toBe(1);
      await history.getByRole("button", { name: "Back to history" }).click();
      await expect(
        history.getByRole("searchbox", { name: "Find in history" }),
      ).toHaveValue("Compare the calibration strategies");
      history = await selectInput();
      const external = history.getByRole("link", { name: "external docs" });
      await expect(external).toHaveAttribute(
        "href",
        "https://example.com/docs",
      );
      await expect(external).toHaveAttribute("target", "_blank");
      const appUrl = page.url();
      for (const markdown of [false, true]) {
        if (markdown) history = await selectInput();
        const resolved = page.waitForRequest(
          (request) =>
            new URL(request.url()).pathname === "/api/resources/resolve",
        );
        await (markdown
          ? history.getByRole("link", { name: "the project document" })
          : history.getByRole("button", { name: "README.md", exact: true })
        ).click();
        expect((await resolved).postDataJSON()).toMatchObject({
          sessionId: "mock-calibration-history",
          reference: "README.md",
        });
        await expect(page.locator(".file-preview")).toBeVisible();
        expect(page.url()).toBe(appUrl);
      }
    });

    test("reads native-shaped shell History and inspects saved images", async ({
      page,
    }) => {
      await connectCalibration(page);
      const history = await openHistory(page);
      await history
        .getByRole("button", { name: "Earlier conversation", exact: true })
        .click();
      const turn = history.locator(".history-turn").filter({
        has: page.getByRole("button", { name: /Review calibration run 599/ }),
      });
      await turn.getByRole("button", { name: "Replies and activity" }).click();
      const shell = turn
        .getByRole("button", {
          name: /Shell command.*!printf.*native-shell-history/,
        })
        .first();
      await expect(shell).toBeVisible();
      await shell.click();
      await expect(
        history.getByText("Included in context", { exact: true }),
      ).toBeVisible();
      await expect(history.locator(".rich-text")).toContainText(
        "!printf 'native-shell-history'",
      );
      await expect(
        history.getByRole("button", { name: "Continue here", exact: true }),
      ).toBeEnabled();
      await expect(
        history.getByRole("button", { name: "Edit in this session" }),
      ).toHaveCount(0);
      await history.getByRole("button", { name: "Back to history" }).click();
      const search = history.getByRole("searchbox", {
        name: "Find in history",
      });
      await search.fill("native-shell-excluded-result");
      await history
        .getByRole("button", {
          name: /Shell command.*native-shell-excluded-result/,
        })
        .click();
      await expect(history.locator(".rich-text")).toContainText(
        "!!printf 'native-shell-history'",
      );
      await expect(
        history.getByText("Excluded from context", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: `output/playwright/history/${size}-shell-detail.png`,
      });
      await history.getByRole("button", { name: "Back to history" }).click();
      await search.fill("Compare the calibration strategies");
      await history
        .getByRole("button", {
          name: /Your input.*Compare the calibration strategies/,
        })
        .click();
      const image = history.getByRole("button", {
        name: "Preview image in this history entry",
      });
      await expect(image.locator("img")).toHaveJSProperty("complete", true);
      if (touch) await image.tap();
      else {
        await image.focus();
        await image.press("Enter");
      }
      const viewer = page.getByRole("dialog", { name: "Image preview" });
      await expect(viewer).toBeVisible();
      await viewer
        .getByRole("button", { name: "Zoom image", exact: true })
        .click();
      await expect(
        viewer.getByRole("button", { name: "Fit image to window" }),
      ).toHaveAttribute("aria-pressed", "true");
      await page.screenshot({
        path: `output/playwright/history/${size}-image-viewer.png`,
      });
      await viewer.getByRole("button", { name: "Close image preview" }).click();
      await expect(image).toBeFocused();
      await image.press("Enter");
      await expect(viewer).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(viewer).toHaveCount(0);
      await expect(history.locator(".history-detail .rich-text")).toContainText(
        "Compare the calibration strategies",
      );
      await expect(image).toBeFocused();
      await page.screenshot({
        path: `output/playwright/history/${size}-image-escape.png`,
      });
      await history.getByRole("button", { name: "Back to history" }).click();
    });

    test("clears a pending search and retries the selected failed detail without losing its place", async ({
      page,
    }) => {
      await connectCalibration(page);
      let release!: () => void;
      const gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      await page.route("**/api/branches/tree?**", async (route) => {
        if (
          new URL(route.request().url()).searchParams.get("query") ===
          "delayed matches"
        )
          await gate;
        await route.continue();
      });
      const history = await openHistory(page);
      const search = history.getByRole("searchbox", {
        name: "Find in history",
      });
      const requested = page.waitForRequest((request) =>
        request.url().includes("query=delayed"),
      );
      await search.fill("delayed matches");
      await requested;
      await expect(history).toHaveAttribute("aria-busy", "true");
      await search.fill("");
      await expect(history).not.toHaveAttribute("aria-busy", "true");
      await expect(
        history.getByRole("button", { name: "Earlier conversation" }),
      ).toBeEnabled();
      release();
      let reads = 0;
      await page.route("**/api/branches/entry?**", async (route) => {
        reads++;
        if (reads === 1)
          await route.fulfill({
            status: 503,
            json: { error: "Preview temporarily unavailable" },
          });
        else await route.continue();
      });
      await search.fill("Review calibration run 598");
      const match = history.getByRole("button", {
        name: /Your input.*Review calibration run 598/,
      });
      await match.click();
      await history
        .getByRole("button", { name: "Retry preview", exact: true })
        .click();
      await expect(history.locator(".rich-text")).toContainText(
        "Review calibration run 598",
      );
      expect(reads).toBe(2);
      await page.screenshot({
        path: `output/playwright/history/${size}-retried-detail.png`,
      });
      await history.getByRole("button", { name: "Back to history" }).click();
      await expect(search).toHaveValue("Review calibration run 598");
      await expect(match).toBeFocused();
    });

    test("reveals inspected route endpoints with quiet responsive controls", async ({
      page,
    }) => {
      page.setDefaultTimeout(8_000);
      await connectCalibration(page);
      const composer = page.getByLabel("Message", { exact: true });
      await composer.fill("UNSENT — retain the calibration notes");
      const history = await openHistory(page);
      await history
        .getByRole("button", { name: "Earlier conversation", exact: true })
        .click();
      await history
        .getByRole("button", { name: "Other routes", exact: true })
        .click();
      await history
        .getByRole("button", {
          name: /Try the alternate calibration strategy with the amber reference/,
        })
        .click();
      const alternate = history.getByRole("button", {
        name: "Try the alternate calibration strategy with the amber reference.",
        exact: true,
      });
      await expect(alternate).toBeInViewport();
      const current = history.getByRole("button", {
        name: "Current conversation",
        exact: true,
      });
      await expect(current).toHaveClass(/button--quiet/);
      await page.screenshot({
        path: `output/playwright/history/${size}-alternate-outline.png`,
      });
      const rows = history.locator(".branch-tree__rows");
      const position = await rows.evaluate((element) => element.scrollTop);
      await alternate.click();
      await history
        .getByRole("button", { name: "Back to history", exact: true })
        .click();
      await expect
        .poll(() => rows.evaluate((element) => element.scrollTop))
        .toBe(position);
      await expect(alternate).toBeFocused();
      await current.click();
      await expect(
        history.getByRole("button", {
          name: /Review calibration run 599.*Current conversation/,
        }),
      ).toBeInViewport();
      await expect(composer).toHaveValue(
        "UNSENT — retain the calibration notes",
      );
      if (touch) {
        await page
          .getByRole("button", { name: "Close context pane", exact: true })
          .click();
        await page.setViewportSize({ width: 320, height: 844 });
        const title = page.getByRole("button", {
          name: /^Session actions:/,
        });
        await expect(title).toBeVisible();
        expect((await title.boundingBox())!.width).toBeGreaterThan(40);
        await expect(
          page.getByRole("button", {
            name: "Open Git changes: mock/analysis, 1 change",
            exact: true,
          }),
        ).toBeHidden();
        await page.screenshot({
          path: "output/playwright/history/narrow-320-topbar.png",
        });
      }
    });

    test("inspects complete older/alternate history and deliberately continues or copies it", async ({
      page,
    }) => {
      test.setTimeout(90_000);
      page.setDefaultTimeout(8_000);
      const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          /\/api\/(branches|prompt)/.test(request.url())
        )
          calls.push({
            path: new URL(request.url()).pathname,
            body: request.postDataJSON(),
          });
      });
      await connectCalibration(page);
      const composer = page.getByLabel("Message", { exact: true });
      await composer.fill("UNSENT — retain the calibration notes");
      let history = await openHistory(page);
      await expect(
        history.getByRole("button", {
          name: /Review calibration run 599.*Current conversation/,
        }),
      ).toBeVisible();
      await expect(history.locator(".history-entry")).toHaveCount(0);
      await page.screenshot({
        path: `output/playwright/history/${size}-outline.png`,
      });

      await history
        .getByRole("button", { name: "Earlier conversation", exact: true })
        .click();
      const olderPrompt = history.getByRole("button", {
        name: "Review calibration run 598: compare residuals and explain the next adjustment.",
        exact: true,
      });
      await expect(olderPrompt).toBeVisible();
      await olderPrompt.scrollIntoViewIfNeeded();
      const rows = history.locator(".branch-tree__rows");
      const priorScroll = await rows.evaluate((element) => element.scrollTop);
      if (touch) await olderPrompt.tap();
      else await olderPrompt.click();
      await expect(
        history.getByRole("button", {
          name: "Edit in this session",
          exact: true,
        }),
      ).toBeEnabled();
      await expect(composer).toHaveValue(
        "UNSENT — retain the calibration notes",
      );
      await history
        .getByRole("button", { name: "Back to history", exact: true })
        .click();
      await expect(olderPrompt).toBeFocused();
      expect(await rows.evaluate((element) => element.scrollTop)).toBe(
        priorScroll,
      );
      await page.screenshot({
        path: `output/playwright/history/${size}-older-outline.png`,
      });
      await history
        .getByRole("button", { name: "Other routes", exact: true })
        .click();
      await history
        .getByRole("button", {
          name: /Try the alternate calibration strategy with the amber reference/,
        })
        .click();
      await expect(
        history.getByText("Inspecting another route", { exact: true }),
      ).toBeVisible();
      await expect(
        history.getByRole("button", {
          name: "Try the alternate calibration strategy with the amber reference.",
          exact: true,
        }),
      ).toBeVisible();
      await expect(composer).toHaveValue(
        "UNSENT — retain the calibration notes",
      );
      expect(calls).toHaveLength(0);
      await page.screenshot({
        path: `output/playwright/history/${size}-alternate-outline.png`,
      });
      await history
        .getByRole("button", { name: "Current conversation", exact: true })
        .click();

      const search = history.getByRole("searchbox", {
        name: "Find in history",
        exact: true,
      });
      await search.fill("cobalt baseline");
      const oldResponse = history.getByRole("button", {
        name: /Response.*cobalt baseline/,
      });
      await expect(oldResponse).toBeVisible();
      await oldResponse.click();
      await expect(
        history.getByRole("button", { name: "Continue here", exact: true }),
      ).toBeEnabled();
      while (
        await history
          .getByRole("button", { name: "Read more content", exact: true })
          .count()
      ) {
        const more = history.getByRole("button", {
          name: "Read more content",
          exact: true,
        });
        await more.click();
        await expect(history).not.toHaveAttribute("aria-busy", "true");
      }
      await expect(
        history.getByText("完整测量记录。", { exact: true }),
      ).toBeVisible();
      await expect(composer).toHaveValue(
        "UNSENT — retain the calibration notes",
      );
      expect(calls).toHaveLength(0);
      await history
        .getByText("完整测量记录。", { exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `output/playwright/history/${size}-complete-preview.png`,
      });
      await history
        .getByRole("button", { name: "Back to history", exact: true })
        .click();
      await expect(search).toHaveValue("cobalt baseline");
      await expect(oldResponse).toBeFocused();

      await search.fill("alternate calibration strategy");
      await history
        .getByRole("button", {
          name: /Your input.*alternate calibration strategy/,
        })
        .click();
      await expect(
        history.getByRole("button", {
          name: "Fork to new session",
          exact: true,
        }),
      ).toBeEnabled();
      await expect(
        history
          .getByRole("group", { name: "New session", exact: true })
          .getByRole("button", { name: "Clone through here", exact: true }),
      ).toBeEnabled();
      await page.screenshot({
        path: `output/playwright/history/${size}-alternate-actions.png`,
      });
      await history
        .getByRole("button", { name: "Fork to new session", exact: true })
        .click();
      await expect(composer).toHaveValue(
        "Try the alternate calibration strategy with the amber reference.",
      );
      expect(calls.at(-1)).toMatchObject({
        path: "/api/branches/fork",
        body: { targetId: "history-alternate" },
      });
      await chooseSource(page);
      await expect(composer).toHaveValue(
        "UNSENT — retain the calibration notes",
      );

      history = await openHistory(page);
      await history
        .getByRole("searchbox", { name: "Find in history" })
        .fill("cobalt baseline");
      await history
        .getByRole("button", { name: /Response.*cobalt baseline/ })
        .click();
      await expect(
        history.getByRole("checkbox", {
          name: "Carry branch summary",
        }),
      ).not.toBeChecked();
      await history
        .getByRole("button", { name: "Continue here", exact: true })
        .click();
      await expect(
        page.getByText("Continuing from earlier history", { exact: true }),
      ).toBeVisible();
      await expect(composer).toHaveValue(
        "UNSENT — retain the calibration notes",
      );
      if (touch)
        await expect(
          page.getByRole("dialog", { name: "Context panel", exact: true }),
        ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Clone from here", exact: true })
        .click();
      await expect(composer).toHaveValue("");
      await expect(
        page.getByText("Continuing from earlier history", { exact: true }),
      ).toHaveCount(0);
      expect(calls.at(-1)?.path).toBe("/api/branches/clone");
      await chooseSource(page);
      await expect(composer).toHaveValue(
        "UNSENT — retain the calibration notes",
      );
      await page
        .getByRole("button", { name: "Back to latest", exact: true })
        .click();
      await expect(
        page.getByText("Continuing from earlier history", { exact: true }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: /^Session actions:/ }).click();
      const cloneButton = page.getByRole("menuitem", {
        name: "Clone current branch",
        exact: true,
      });
      if (touch) await cloneButton.tap();
      else await cloneButton.click();
      await expect(composer).toHaveValue("");
      await page.screenshot({
        path: `output/playwright/history/${size}-clone.png`,
      });

      const palette = await openCommandPalette(page);
      await palette.getByLabel("Filter commands").fill("clone");
      await palette
        .getByRole("option", { name: /Clone current branch/ })
        .click();
      await expect(palette).toHaveCount(0);
      await expect
        .poll(
          () =>
            calls.filter((call) => call.path === "/api/branches/clone").length,
        )
        .toBe(3);
      await expect(
        page.getByRole("button", { name: /^Session actions:/ }),
      ).toBeEnabled();
      await expect(composer).toHaveValue("");
      await composer.fill("/clone");
      const send = page.getByRole("button", {
        name: "Send message",
        exact: true,
      });
      if (touch) await send.tap();
      else await send.click();
      await expect
        .poll(
          () =>
            calls.filter((call) => call.path === "/api/branches/clone").length,
        )
        .toBe(4);
      await expect(
        page.getByRole("button", { name: /^Session actions:/ }),
      ).toBeEnabled();
      await expect(composer).toHaveValue("");
      expect(
        calls.filter((call) => call.path === "/api/branches/clone"),
      ).toHaveLength(4);
      expect(calls.filter((call) => call.path === "/api/prompt")).toHaveLength(
        0,
      );
      expect(errors).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
      ).toBe(false);
    });
  });
}

test("navigates to a native shell card and opens its complete log on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connectCalibration(page);
  await page.getByRole("button", { name: "Open conversation search" }).click();
  const search = page.getByRole("searchbox", { name: "Search conversation" });
  await search.fill("COMPLETE_NATIVE_SHELL_LOG_END");
  await expect(page.getByLabel("Transcript search matches")).toContainText(
    "1 match",
  );
  await search.press("Enter");
  const card = page
    .getByRole("region", { name: "Shell command" })
    .filter({ hasText: "Included in context" });
  const action = card.getByRole("button", {
    name: "View full output",
    exact: true,
  });
  await expect(action).toBeInViewport();
  const reference = resolve(browserWorkspace, "native-shell.log");
  await expect(action).toHaveAttribute("data-file-path", reference);
  const resolved = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/resources/resolve" &&
      request.postDataJSON().reference === reference,
  );
  await action.click();
  expect((await resolved).postDataJSON().sessionId).toBe(
    "mock-calibration-history",
  );
  const source = page.getByRole("region", { name: "File source" });
  await expect(source).toBeVisible();
  expect(await source.locator("code").textContent()).toBe(
    await readFile(reference, "utf8"),
  );
  await page.screenshot({
    path: "output/playwright/history/narrow-shell-full-output.png",
  });
});

test("History Edit with a delayed summary preserves a newer draft and image", async ({
  page,
}) => {
  await connectCalibration(page);
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Confirmed draft");
  const history = await openHistory(page);
  await history
    .getByRole("searchbox", { name: "Find in history" })
    .fill("Review calibration run 598");
  await history
    .getByRole("button", { name: /Your input.*Review calibration run 598/ })
    .click();
  await history.getByRole("checkbox", { name: "Carry branch summary" }).check();
  let release!: () => void;
  const summary = new Promise<void>((resolveSummary) => {
    release = resolveSummary;
  });
  await page.route("**/api/branches/navigate", async (route) => {
    await summary;
    await route.continue();
  });
  page.on("dialog", (dialog) => void dialog.accept());
  const dispatched = page.waitForRequest("**/api/branches/navigate");
  await history
    .getByRole("button", { name: "Edit in this session", exact: true })
    .click();
  await dispatched;
  await composer.fill("Newer draft typed while waiting");
  await page.locator('input[type="file"]').setInputFiles({
    name: "newer-image.gif",
    mimeType: "image/gif",
    buffer: Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    ),
  });
  await expect(page.locator(".attachment--ready")).toBeVisible();
  release();
  await expect(
    page.getByText("Continuing from earlier history", { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue("Newer draft typed while waiting");
  await expect(page.locator(".attachment--image")).toHaveCount(1);
  await expect(
    page.getByText("Conversation changed; your newer draft was kept.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/playwright/history/desktop-newer-summary-draft.png",
  });
  await page
    .getByRole("button", { name: "Back to latest", exact: true })
    .click();
});
