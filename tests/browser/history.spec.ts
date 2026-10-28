import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import {
  openCommandPalette,
  openMockSession,
  pairedPage,
} from "./support/navigation";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });

async function chooseSource(page: Page) {
  await openMockSession(page, /Calibration history fixture/);
}

async function openHistory(page: Page) {
  const toggle = page.getByRole("button", {
    name: "Toggle resources panel",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await page.getByRole("tab", { name: "History", exact: true }).click();
  const history = page.getByRole("region", { name: "Conversation history" });
  await expect(history).toBeVisible();
  return history;
}

async function connectCalibration(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await chooseSource(page);
}

test("History read failure keeps Retry reachable in short panes", async ({
  page,
}) => {
  let refuse = true;
  await page.route("**/api/branches/tree**", async (route) => {
    if (refuse)
      await route.fulfill({
        status: 422,
        json: { error: "History could not be read" },
      });
    else await route.fallback();
  });
  await connectCalibration(page);
  const toggle = page.getByRole("button", {
    name: "Toggle resources panel",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  const pane = page.locator(".ctx");
  await pane.getByRole("tab", { name: "History", exact: true }).click();
  await expect(
    pane.getByText("History is unavailable.", { exact: true }),
  ).toBeVisible();
  const retry = pane.getByRole("button", { name: "Retry", exact: true });
  for (const [width, height] of [
    [1280, 900],
    [901, 390],
    [320, 320],
  ]) {
    await page.setViewportSize({ width, height });
    await retry.focus();
    await retry.scrollIntoViewIfNeeded();
    const box = await retry.boundingBox();
    const viewport = await pane.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(viewport!.y);
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      viewport!.y + viewport!.height,
    );
    expect(
      await retry.evaluate((el) => parseFloat(getComputedStyle(el).marginTop)),
    ).toBe(8);
    await expect(retry).toBeFocused();
  }
  refuse = false;
  await retry.click();
  await expect(
    pane.getByRole("region", { name: "Conversation history" }),
  ).toBeVisible();
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
  const restored = composer.locator(".image-preview--attachment");
  await expect(restored).toHaveCount(1);
  await expect(restored.locator("img")).toHaveJSProperty("naturalWidth", 720);
  await restored.click();
  const viewer = page.getByRole("dialog", { name: "Image preview" });
  await expect(viewer).toBeVisible();
  await viewer.getByRole("button", { name: "Close image preview" }).click();
  // New uploads and restored images share removal and submission behavior.
  await composer
    .locator('input[type="file"][aria-label="Attach files"]')
    .setInputFiles("tests/browser/fixtures/file-previews/training curve.png");
  await expect(restored).toHaveCount(2);
  await composer
    .getByRole("button", { name: "Remove attached image" })
    .last()
    .click();
  await expect(restored).toHaveCount(1);
  await input.fill("Compare the saved image again");

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

test("recovers a History image and opens local references in the authorized session reader", async ({
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
  await expect(
    history.getByText("Loading image…", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => imageRequests.length).toBeGreaterThan(0);
  await expect(
    history.getByRole("button", { name: "Retry image", exact: true }),
  ).toHaveCount(0);
  const failedReads = imageRequests.length;
  imageAvailable = true;
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
  await expect(external).toHaveAttribute("href", "https://example.com/docs");
  await expect(external).toHaveAttribute("target", "_blank");
  const appUrl = page.url();
  for (const markdown of [false, true]) {
    if (markdown) history = await selectInput();
    const resolved = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/resources/resolve",
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
  const shellPreview = history.getByRole("region", {
    name: "Shell record preview",
  });
  await expect(shellPreview).toContainText("Included in context");
  await expect(shellPreview).toContainText("!printf 'native-shell-history'");
  await expect(
    shellPreview.getByRole("button", { name: /Insert.*terminal/ }),
  ).toHaveCount(0);
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
  await expect(shellPreview).toContainText("!!printf 'native-shell-history'");
  await expect(shellPreview).toContainText("Excluded from context");

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
  {
    await image.focus();
    await image.press("Enter");
  }
  const viewer = page.getByRole("dialog", { name: "Image preview" });
  await expect(viewer).toBeVisible();
  await viewer.getByRole("button", { name: "Actual size" }).click();
  await viewer.getByRole("button", { name: "Zoom in" }).click();
  await expect(viewer.getByRole("button", { name: "Actual size" })).toHaveText(
    "125%",
  );

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

  await history.getByRole("button", { name: "Back to history" }).click();
  await search.fill("COMPLETE_NATIVE_SHELL_LOG_END");
  await history
    .getByRole("button", { name: /Shell command.*native-shell-history/ })
    .click();
  const fullLog = shellPreview.getByRole("button", {
    name: "View full shell output",
  });
  const reference = (await fullLog.getAttribute("data-file-path"))!;
  const resolvedLog = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/resources/resolve",
  );
  await fullLog.click();
  expect((await resolvedLog).postDataJSON()).toMatchObject({
    sessionId: "mock-calibration-history",
    reference,
  });
  const source = page.getByRole("region", { name: "File source" });
  await expect(source).toBeVisible();
  expect(await source.locator("code").textContent()).toBe(
    await readFile(reference, "utf8"),
  );
});

test("clears a pending search and recovers the selected detail without losing its place", async ({
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
  let releaseDetail!: () => void;
  const detailGate = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  await page.route("**/api/branches/entry?**", async (route) => {
    reads++;
    if (reads === 1)
      await route.fulfill({
        status: 503,
        json: { error: "Preview temporarily unavailable" },
      });
    else {
      await detailGate;
      await route.continue();
    }
  });
  await search.fill("Review calibration run 598");
  const match = history.getByRole("button", {
    name: /Your input.*Review calibration run 598/,
  });
  await match.click();
  await expect(
    history.getByRole("button", { name: "Retry preview", exact: true }),
  ).toHaveCount(0);
  try {
    const loading = history.locator(".history-detail__body > p[role=status]");
    await expect(loading).toContainText("Loading complete content");
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const layout = await loading.evaluate((el) => {
        const line = el.getBoundingClientRect();
        const icon = el.querySelector("svg")!.getBoundingClientRect();
        const text = [...el.childNodes].find(
          (node) =>
            node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        )!;
        const offset = text.textContent!.search(/\S/);
        const range = document.createRange();
        range.setStart(text, offset);
        range.setEnd(text, offset + 1);
        return {
          center: icon.y + icon.height / 2 - (line.y + line.height / 2),
          gap: range.getBoundingClientRect().left - icon.right,
        };
      });
      expect(Math.abs(layout.center)).toBeLessThanOrEqual(0.25);
      expect(layout.gap).toBeCloseTo(8, 1);
    }
    for (const label of ["Fork to new session", "Clone through here"]) {
      const action = history.getByRole("button", { name: label, exact: true });
      await expect(action).toBeDisabled();
      await expect(action).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(action).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    }
  } finally {
    releaseDetail();
  }
  await expect(history.locator(".rich-text")).toContainText(
    "Review calibration run 598",
  );
  expect(reads).toBe(2);

  await history.getByRole("button", { name: "Back to history" }).click();
  await expect(search).toHaveValue("Review calibration run 598");
  await expect(match).toBeFocused();
});

test.describe("touch History navigation", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  test("reveals inspected route endpoints with quiet responsive controls", async ({
    page,
  }) => {
    page.setDefaultTimeout(8000);
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
    await expect(composer).toHaveValue("UNSENT — retain the calibration notes");
    {
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
    }
  });
});

test.describe("touch History navigation", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  test("inspects complete older/alternate history and deliberately continues or copies it", async ({
    page,
  }) => {
    test.setTimeout(90000);
    page.setDefaultTimeout(8000);
    const calls: Array<{
      path: string;
      body: Record<string, unknown>;
    }> = [];
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
    await olderPrompt.tap();
    await expect(
      history.getByRole("button", {
        name: "Edit in this session",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(composer).toHaveValue("UNSENT — retain the calibration notes");
    await history
      .getByRole("button", { name: "Back to history", exact: true })
      .click();
    await expect(olderPrompt).toBeFocused();
    expect(await rows.evaluate((element) => element.scrollTop)).toBe(
      priorScroll,
    );

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
    await expect(composer).toHaveValue("UNSENT — retain the calibration notes");
    expect(calls).toHaveLength(0);

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
    await expect(composer).toHaveValue("UNSENT — retain the calibration notes");
    expect(calls).toHaveLength(0);
    await history
      .getByText("完整测量记录。", { exact: true })
      .scrollIntoViewIfNeeded();

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
    await expect(composer).toHaveValue("UNSENT — retain the calibration notes");
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
    await expect(composer).toHaveValue("UNSENT — retain the calibration notes");
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
    await expect(composer).toHaveValue("UNSENT — retain the calibration notes");
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
    await cloneButton.tap();
    await expect(composer).toHaveValue("");
    await composer.fill("UNSENT — keep this in the source clone");

    const palette = await openCommandPalette(page);
    await palette.getByLabel("Filter commands").fill("clone");
    await palette.getByRole("option", { name: /Clone current branch/ }).click();
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
    await send.tap();
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
    expect(calls.filter((call) => call.path === "/api/prompt")).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
  });
});

test("navigates to a native shell card and opens its complete log on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connectCalibration(page);
  await page.getByRole("button", { name: "Open conversation search" }).click();
  const search = page.getByRole("searchbox", {
    name: "Search conversation",
  });
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

  await page
    .getByRole("button", { name: "Back to latest", exact: true })
    .click();
});

test("earlier-branch progress identifies the action while keeping both failures recoverable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openMockSession(page, /Earlier branch recovery fixture/);
  const banner = page.getByRole("region", { name: "Earlier branch context" });
  await expect(banner).toBeVisible();
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep the calibration draft");
  for (const [endpoint, label, otherLabel] of [
    ["clone", "Clone from here", "Back to latest"],
    ["navigate", "Back to latest", "Clone from here"],
  ]) {
    let release!: () => void;
    let arrive!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const pattern = `**/api/branches/${endpoint}`;
    await page.route(pattern, async (route) => {
      arrive();
      await gate;
      await route.fulfill({
        status: 503,
        json: { error: "Operation temporarily unavailable. Try again." },
      });
    });
    const chosen = banner.getByRole("button", { name: label, exact: true });
    const other = banner.getByRole("button", { name: otherLabel, exact: true });
    try {
      await chosen.click();
      await requested;
      await expect(chosen).toHaveAttribute("aria-busy", "true");
      await expect(chosen.locator(".pi-loading")).toHaveCount(1);
      await expect(other.locator(".pi-loading")).toHaveCount(0);
      await expect(chosen).toBeDisabled();
      await expect(other).toBeDisabled();
      for (const [width, height] of [
        [1280, 900],
        [390, 844],
        [320, 640],
      ]) {
        await page.setViewportSize({ width, height });
        await expect(chosen).toBeInViewport();
        expect(
          await chosen.evaluate((button) => {
            const box = button.getBoundingClientRect();
            const owner = button
              .closest(".earlier-branch-banner")!
              .getBoundingClientRect();
            return (
              box.left >= owner.left &&
              box.right <= owner.right &&
              box.top >= owner.top &&
              box.bottom <= owner.bottom
            );
          }),
        ).toBe(true);
        await expect(chosen.locator(".pi-loading")).toHaveCount(1);
      }
    } finally {
      release();
    }
    await expect(banner.getByRole("alert")).toContainText(
      "Operation temporarily unavailable",
    );
    await expect(chosen).toBeEnabled();
    await expect(other).toBeEnabled();
    await expect(banner.locator(".pi-loading")).toHaveCount(0);
    await expect(draft).toHaveValue("Keep the calibration draft");
    await page.unroute(pattern);
  }
});

test("earlier-branch notice follows reader width and reserves wrapped diagnostics", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await connectCalibration(page);
  page.on("dialog", (dialog) => void dialog.accept());
  const history = await openHistory(page);
  await history
    .getByRole("searchbox", { name: "Find in history" })
    .fill("Review calibration run 598");
  await history
    .getByRole("button", { name: /Your input.*Review calibration run 598/ })
    .click();
  await history
    .getByRole("button", { name: "Edit in this session", exact: true })
    .click();
  const banner = page.getByRole("region", { name: "Earlier branch context" });
  await expect(banner).toBeVisible();
  const reader = page.locator(".reading-stage");
  const resize = page.getByRole("separator", {
    name: "Resize files panel",
    exact: true,
  });
  for (let step = 0; step < 8; step++) {
    const before = (await reader.boundingBox())!.width;
    if (before <= 400.5) break;
    await resize.press("ArrowLeft");
    await expect
      .poll(async () => (await reader.boundingBox())!.width)
      .toBeLessThan(before - 0.5);
  }
  await expect
    .poll(async () => (await reader.boundingBox())!.width)
    .toBeLessThanOrEqual(400.5);
  const measure = () =>
    banner.evaluate((root) => {
      const r = (element: Element) => element.getBoundingClientRect();
      const stage = r(root.closest(".reading-stage")!);
      const header = r(root.querySelector(".earlier-branch-banner__header")!);
      const copy = root.querySelector(".earlier-branch-banner__copy")!;
      const title = root.querySelector("strong")!;
      const mark = r(
        root.querySelector(".earlier-branch-banner__header > svg")!,
      );
      const actions = r(root.querySelector(".earlier-branch-banner__actions")!);
      const transcript = root.parentElement!.querySelector(".transcript")!;
      const style = getComputedStyle(transcript);
      const contentStyle = getComputedStyle(
        transcript.querySelector(".transcript__content")!,
      );
      const needed =
        r(root).bottom -
        r(transcript).top +
        Number.parseFloat(style.getPropertyValue("--space-4"));
      const range = document.createRange();
      range.selectNodeContents(copy);
      return {
        firstLineOffset:
          mark.y +
          mark.height / 2 -
          r(title).y -
          Number.parseFloat(getComputedStyle(title).lineHeight) / 2,
        textFits: [...range.getClientRects()].every(
          (box) =>
            box.left >= r(copy).left - 0.5 && box.right <= r(copy).right + 0.5,
        ),
        controlsFit:
          actions.left >= r(root).left && actions.right <= r(root).right,
        separated:
          stage.width <= 640
            ? actions.top >= header.bottom
            : actions.left >= header.right,
        paddingRoom:
          Math.min(
            Number.parseFloat(contentStyle.paddingTop),
            Number.parseFloat(style.scrollPaddingTop),
          ) - needed,
      };
    });
  const checkGeometry = async () => {
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(async () => (await measure()).paddingRoom)
      .toBeGreaterThanOrEqual(-0.5);
    const geometry = await measure();
    expect(Math.abs(geometry.firstLineOffset)).toBeLessThanOrEqual(0.5);
    expect(geometry.textFits).toBe(true);
    expect(geometry.controlsFit).toBe(true);
    expect(geometry.separated).toBe(true);
  };
  await checkGeometry();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const diagnostic =
    "Unable to read the earlier conversation in /workspace/calibration/long-path-analysis/measurements/reference-calibration-history/session.jsonl. Restore access to the project directory and retry. No conversation changes were saved.";
  await page.route("**/api/branches/navigate", async (route) => {
    await gate;
    await route.fulfill({ status: 503, json: { error: diagnostic } });
  });
  await banner
    .getByRole("button", { name: "Back to latest", exact: true })
    .click();
  await expect(banner.locator(".pi-loading")).toBeVisible();
  await checkGeometry();
  release();
  await expect(banner.getByRole("alert")).toHaveText(diagnostic);
  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const close = page.getByRole("button", {
      name: "Close context pane",
      exact: true,
    });
    if (width <= 900 && (await close.isVisible())) await close.click();
    await checkGeometry();
  }
  await page.unroute("**/api/branches/navigate");
  await banner
    .getByRole("button", { name: "Back to latest", exact: true })
    .click();
  await expect(banner).toHaveCount(0);
  expect(
    await page
      .locator(".transcript-wrap")
      .evaluate((wrap) =>
        (wrap as HTMLElement).style.getPropertyValue(
          "--earlier-branch-banner-bottom",
        ),
      ),
  ).toBe("");
  expect(errors).toEqual([]);
});
