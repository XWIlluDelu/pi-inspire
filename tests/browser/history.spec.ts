import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type {
  ActiveSnapshot,
  BranchTreeResponse,
} from "../../shared/contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { hostRequest } from "./support/host-request";
import {
  openCommandPalette,
  openConversationSearch,
  openFixtureSession,
  openHistoryPane,
  pairedPage,
  reloadSession,
} from "./support/navigation";
import { firstTextBaseline } from "./support/text-baseline";
import { textOverflowsInlineBounds } from "./support/text-bounds";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });

async function chooseSource(page: Page) {
  await openFixtureSession(
    page,
    /Calibration history fixture/,
    "fixture-calibration-history",
  );
}

async function connectCalibration(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await chooseSource(page);
}

test("History failures recover in a short drawer and the chosen preview survives reload", async ({
  page,
}) => {
  let refuseTree = true;
  let entryFailure: 403 | 404 | null = 403;
  let resumePreview!: () => void;
  const previewReady = new Promise<void>((resolve) => {
    resumePreview = resolve;
  });
  const diagnostic =
    "Cannot preview /workspace/calibration/instrument_calibration_reference_acquisition_results_archive.jsonl. Restore access and retry.";
  await page.route("**/api/branches/tree**", (route) =>
    refuseTree
      ? route.fulfill({
          status: 422,
          json: { error: "History could not be read" },
        })
      : route.fallback(),
  );
  await page.route("**/api/branches/entry?**", async (route) => {
    if (entryFailure)
      return route.fulfill({
        status: entryFailure,
        json: {
          error:
            entryFailure === 403
              ? diagnostic
              : "History entry no longer exists",
        },
      });
    await previewReady;
    await route.fallback();
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
  await page.setViewportSize({ width: 320, height: 420 });
  await expect(pane).toHaveAttribute("role", "dialog");

  const retry = pane.getByRole("button", { name: "Retry", exact: true });
  await retry.focus();
  await expect(retry).toBeInViewport();
  refuseTree = false;
  await retry.press("Enter");
  const history = pane.getByRole("region", { name: "Conversation history" });
  const search = history.getByRole("searchbox", { name: "Find in history" });
  const query = "Review calibration run 598";
  await search.fill(query);
  const entry = history.getByRole("button", {
    name: /Your input.*Review calibration run 598/,
  });
  await entry.click();
  const warning = history.getByRole("alert");
  await expect(warning).toHaveText(diagnostic);
  await page.evaluate(() => document.fonts.ready);
  expect(await warning.evaluate(textOverflowsInlineBounds)).toBe(false);

  const retryPreview = history.getByRole("button", { name: "Retry preview" });
  await retryPreview.focus();
  await expect(retryPreview).toBeInViewport();
  entryFailure = null;
  try {
    await retryPreview.press("Enter");
    await expect(history.getByRole("status")).toContainText(
      "Loading complete content",
    );
    for (const name of ["Fork to new session", "Clone through here"]) {
      await expect(history.getByRole("button", { name })).toBeDisabled();
    }
  } finally {
    resumePreview();
  }
  await expect(history.locator(".rich-text")).toContainText(query);
  const back = history.getByRole("button", { name: "Back to history" });
  await back.click();
  await expect(entry).toBeFocused();
  await entry.click();
  await expect(history.locator(".rich-text")).toContainText(query);
  await page.reload();
  await expect(history.locator(".rich-text")).toContainText(query);
  entryFailure = 404;
  await page.reload();
  await expect(warning).toHaveText("History entry no longer exists");
  await expect(retryPreview).toBeEnabled();
  await back.click();
  await expect(search).toHaveValue(query);
  entryFailure = null;
  await entry.click();
  await expect(history.locator(".rich-text")).toContainText(query);
});

test.describe("narrow History route labels", () => {
  test.use({ viewport: { width: 320, height: 900 }, hasTouch: true });
  test("aligns the first-line mark and metadata without clipping wrapped routes", async ({
    page,
  }) => {
    const description =
      "比较校准残差与参考采集结果，并在复查仪器重复性之前保留基线修正，再检查不同批次测量之间的偏差。";
    await page.route("**/api/branches/tree?**", async (route) => {
      if (!new URL(route.request().url()).searchParams.has("parentId"))
        return route.fallback();
      const response = await route.fetch();
      const body: BranchTreeResponse = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          nodes: body.nodes.map((node) => ({
            ...node,
            snippet: node.active ? description : "Saved calibration route",
          })),
        },
      });
    });
    await pairedPage(page);
    await openFixtureSession(page, /Calibration history fixture/);
    const history = await openHistoryPane(page);
    await history
      .getByRole("button", { name: "Earlier conversation", exact: true })
      .click();
    const disclosure = history.getByRole("button", {
      name: "Other routes",
      exact: true,
    });
    expect((await disclosure.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await disclosure.click();
    const routes = history.getByRole("group", {
      name: "Routes from this point",
    });
    const current = routes
      .locator(".history-route")
      .filter({ hasText: description });
    const short = routes.getByRole("button", {
      name: "Saved calibration route",
      exact: true,
    });
    await expect(current).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const label = await current
      .locator("span")
      .evaluate(firstTextBaseline, ".history-route");
    const metadata = await current
      .locator("small")
      .evaluate(firstTextBaseline, ".history-route");
    expect(Math.abs(metadata! - label!)).toBeLessThanOrEqual(0.5);
    const currentGeometry = await current.evaluate((row) => {
      const label = row.querySelector("span")!;
      const lineHeight = parseFloat(getComputedStyle(label).lineHeight);
      const text = label.getBoundingClientRect();
      const icon = row.querySelector("svg")!.getBoundingClientRect();
      return {
        lines: text.height / lineHeight,
        iconOffset: icon.y + icon.height / 2 - text.y - lineHeight / 2,
        overflow: row.scrollWidth - row.clientWidth,
      };
    });
    expect(currentGeometry.lines).toBeGreaterThan(1);
    expect(Math.abs(currentGeometry.iconOffset)).toBeLessThanOrEqual(0.5);
    expect(currentGeometry.overflow).toBeLessThanOrEqual(1);
    expect((await short.boundingBox())!.height).toBeCloseTo(44, 0);
  });
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
  const history = await openHistoryPane(page);
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
  await input.clear();

  const prompt = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/prompt",
  );
  await composer
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  expect((await prompt).postDataJSON()).toMatchObject({
    sessionId: forked.sessionId,
    message: "",
    attachmentIds: [forked.editorAttachments[0].id],
  });
  await expect(restored).toHaveCount(0);
  await expect(input).toHaveValue("");

  const sent = page.locator(".user-bubble").last();
  await expect(sent).toBeVisible();
  await page.reload();
  const sentPreview = sent.getByRole("button", {
    name: "Preview attached image",
  });
  await expect(sentPreview.locator("img")).toHaveJSProperty(
    "naturalWidth",
    720,
  );
  await expect(sentPreview.locator("img")).toHaveAttribute(
    "draggable",
    "false",
  );
  await sentPreview.click();
  await expect(viewer.locator("img")).toHaveJSProperty("naturalWidth", 720);
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
    const history = await openHistoryPane(page);
    const back = history.getByRole("button", {
      name: "Back to history",
      exact: true,
    });
    if (await back.isVisible()) await back.click();
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
  await image.press("Enter");
  const viewer = page.getByRole("dialog", { name: "Image preview" });
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(image).toBeFocused();

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
      sessionId: "fixture-calibration-history",
      reference: "README.md",
    });
    await expect(page.locator(".file-preview")).toBeVisible();
    expect(page.url()).toBe(appUrl);
  }
});

test("finds saved shell output and opens its full log through History", async ({
  page,
}) => {
  await connectCalibration(page);
  const fullOutput = "COMPLETE_NATIVE_SHELL_LOG_END";
  const reference = resolve(browserWorkspace, "native-shell.log");

  await openConversationSearch(page);
  const transcriptSearch = page.getByRole("searchbox", {
    name: "Search conversation",
  });
  await transcriptSearch.fill(fullOutput);
  await expect(page.getByLabel("Transcript search matches")).toContainText(
    "1 match",
  );
  const history = await openHistoryPane(page);
  const search = history.getByRole("searchbox", { name: "Find in history" });
  await search.fill("native-shell-excluded-result");
  await history
    .getByRole("button", {
      name: /Shell command.*native-shell-excluded-result/,
    })
    .click();
  const shellPreview = history.getByRole("region", {
    name: "Shell record preview",
  });
  await expect(shellPreview).toContainText("Excluded from context");

  await history.getByRole("button", { name: "Back to history" }).click();
  await search.fill(fullOutput);
  await history
    .getByRole("button", { name: /Shell command.*native-shell-history/ })
    .click();
  await expect(shellPreview).toContainText("Included in context");
  await expect(
    history.getByRole("button", { name: "Continue here", exact: true }),
  ).toBeEnabled();
  await expect(
    history.getByRole("button", { name: "Edit in this session" }),
  ).toHaveCount(0);

  await page.setViewportSize({ width: 600, height: 900 });
  const resolvedLog = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/resources/resolve",
  );
  await shellPreview
    .getByRole("button", { name: "View full shell output" })
    .click();
  expect((await resolvedLog).postDataJSON()).toMatchObject({
    sessionId: "fixture-calibration-history",
    reference,
  });
  const source = page.getByRole("region", { name: "File source" });
  await expect(source).toBeVisible();
  expect(await source.locator("code").textContent()).toBe(
    await readFile(reference, "utf8"),
  );
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
    let history = await openHistoryPane(page);
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
    const scrollTo = (surface: Locator, top: number) =>
      surface.evaluate((element, offset) => {
        element.scrollTop = offset;
        element.dispatchEvent(new Event("scroll"));
        return element.scrollTop;
      }, top);
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
      .press("Escape");
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
    const alternate = history.getByRole("button", {
      name: "Try the alternate calibration strategy with the amber reference.",
      exact: true,
    });
    await expect(alternate).toBeInViewport();
    const alternatePosition = await rows.evaluate(
      (element) => element.scrollTop,
    );
    await alternate.click();
    await history.getByRole("button", { name: "Back to history" }).click();
    await expect(alternate).toBeFocused();
    await expect
      .poll(() => rows.evaluate((element) => element.scrollTop))
      .toBe(alternatePosition);
    await expect(composer).toHaveValue("UNSENT — retain the calibration notes");
    expect(calls).toHaveLength(0);

    const savedOutline = await scrollTo(rows, 180);
    expect(savedOutline).toBeGreaterThan(0);
    await page.reload();
    await expect(
      history.getByText("Inspecting another route", { exact: true }),
    ).toBeVisible();
    await expect(alternate).toBeVisible();
    await expect
      .poll(() => rows.evaluate((element) => element.scrollTop))
      .toBe(savedOutline);
    expect(calls).toHaveLength(0);

    await history
      .getByRole("button", { name: "Current conversation", exact: true })
      .click();
    await expect(
      history.getByRole("button", {
        name: /Review calibration run 599.*Current conversation/,
      }),
    ).toBeInViewport();
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
    const more = history.getByRole("button", { name: "Read more content" });
    const tail = history.getByText("完整测量记录。", { exact: true });
    await expect(more).toBeVisible();
    await history
      .getByRole("button", { name: "Back to history", exact: true })
      .click();
    await expect(oldResponse).toBeFocused();
    await oldResponse.click();
    await expect(more).toBeVisible();
    await expect(tail).toHaveCount(0);
    const detail = history.locator(".history-detail__body");
    const savedDetail = await scrollTo(detail, 220);
    expect(savedDetail).toBeGreaterThan(0);
    await page.reload();
    await expect(more).toBeVisible();
    await expect
      .poll(() => detail.evaluate((element) => element.scrollTop))
      .toBe(savedDetail);
    while (await more.count()) {
      await more.click();
      await expect(history).not.toHaveAttribute("aria-busy", "true");
    }
    await expect(tail).toBeVisible();
    await expect(composer).toHaveValue("UNSENT — retain the calibration notes");
    expect(calls).toHaveLength(0);
    await history
      .getByRole("group", { name: "New session", exact: true })
      .getByRole("button", { name: "Clone through here", exact: true })
      .click();
    await expect(composer).toHaveValue("");
    expect(calls.at(-1)).toMatchObject({
      path: "/api/branches/clone",
      body: { targetId: "history-a-0" },
    });
    await chooseSource(page);
    await expect(composer).toHaveValue("UNSENT — retain the calibration notes");
    history = await openHistoryPane(page);
    await history
      .getByRole("button", { name: "Back to history", exact: true })
      .click();
    await expect(search).toHaveValue("cobalt baseline");
    await expect(oldResponse).toBeVisible();
    await oldResponse.click();
    await expect(
      history.getByRole("checkbox", {
        name: "Carry branch summary",
      }),
    ).not.toBeChecked();
    await history
      .getByRole("button", { name: "Continue here", exact: true })
      .click();
    const banner = page.getByRole("region", { name: "Earlier continuation" });
    await expect(
      banner.getByText("Continuing from earlier history"),
    ).toBeVisible();
    await expect(composer).toHaveValue("UNSENT — retain the calibration notes");
    await expect(
      page.getByRole("dialog", { name: "Context panel", exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(banner).toBeVisible();
    const navigations = () =>
      calls.filter((call) => call.path === "/api/branches/navigate").length;
    const beforeDismiss = navigations();
    await banner
      .getByRole("button", { name: "Dismiss earlier continuation notice" })
      .click();
    await expect(banner).toHaveCount(0);
    expect(navigations()).toBe(beforeDismiss);
    const palette = await openCommandPalette(page);
    await palette
      .getByLabel("Filter commands")
      .fill("restore latest saved position");
    const restored = page.waitForResponse("**/api/branches/navigate");
    await palette
      .getByRole("option", { name: /Restore latest saved position/ })
      .click();
    expect((await restored).ok()).toBe(true);
    const latest: BranchTreeResponse = await (
      await hostRequest(page).get(
        "/api/branches/tree?sessionId=fixture-calibration-history",
      )
    ).json();
    expect(latest.effectiveLeafId).toBe(latest.durableLeafId);
    await expect(composer).toHaveValue("UNSENT — retain the calibration notes");
    expect(calls.filter((call) => call.path === "/api/prompt")).toHaveLength(0);
  });
});

test("History Edit with a delayed summary preserves a newer draft and image", async ({
  page,
}) => {
  await connectCalibration(page);
  // A carried summary commits history. Copy before compaction so the older
  // input remains in the copied model context, without mutating the seed.
  const source: ActiveSnapshot = await (
    await hostRequest(page).get(
      "/api/snapshot?detail=fixture-calibration-history",
    )
  ).json();
  const copied = await hostRequest(page).post("/api/branches/clone", {
    data: {
      sessionId: source.active!.sessionId,
      viewId: source.active!.transcriptPage.viewId,
      targetId: "history-a-598",
    },
  });
  expect(copied.ok()).toBe(true);
  await reloadSession(page, (await copied.json()).snapshot.active.sessionId);
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Confirmed draft");
  const history = await openHistoryPane(page);
  await history
    .getByRole("searchbox", { name: "Find in history" })
    .fill("Review calibration run 598");
  await history
    .getByRole("button", { name: /Your input.*Review calibration run 598/ })
    .click();
  const edit = history.getByRole("button", {
    name: "Edit in this session",
    exact: true,
  });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await edit.click();
  await expect(edit).toBeEnabled();
  await expect(composer).toHaveValue("Confirmed draft");
  await history.getByRole("checkbox", { name: "Carry branch summary" }).check();
  await history
    .getByRole("textbox", { name: "Summary instructions" })
    .fill("Keep the measurements");
  let release!: () => void;
  const summary = new Promise<void>((resolveSummary) => {
    release = resolveSummary;
  });
  await page.route("**/api/branches/navigate", async (route) => {
    await summary;
    await route.continue();
  });
  page.once("dialog", (dialog) => void dialog.accept());
  const dispatched = page.waitForRequest("**/api/branches/navigate");
  await edit.click();
  expect((await dispatched).postDataJSON()).toMatchObject({
    mode: "edit",
    summarize: true,
    customInstructions: "Keep the measurements",
  });
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
  const completed = page.waitForResponse("**/api/branches/navigate");
  release();
  expect((await completed).ok()).toBe(true);
  await expect(composer).toHaveValue("Newer draft typed while waiting");
  await expect(page.locator(".attachment--image")).toHaveCount(1);
  await expect(
    page.getByText("Conversation changed; your newer draft was kept.", {
      exact: true,
    }),
  ).toBeVisible();
});

test("earlier-branch restore remains reachable when its diagnostic wraps", async ({
  page,
}) => {
  await connectCalibration(page);
  page.on("dialog", (dialog) => void dialog.accept());
  const history = await openHistoryPane(page);
  await history
    .getByRole("searchbox", { name: "Find in history" })
    .fill("Review calibration run 598");
  await history
    .getByRole("button", { name: /Your input.*Review calibration run 598/ })
    .click();
  await history
    .getByRole("button", { name: "Edit in this session", exact: true })
    .click();
  const banner = page.getByRole("region", { name: "Earlier continuation" });
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
  const fitsReader = () =>
    banner.evaluate((element) => {
      const banner = element.getBoundingClientRect();
      const reader = element.closest(".reading-stage")!.getBoundingClientRect();
      const transcript = element.parentElement!.querySelector(".transcript")!;
      const content = transcript.querySelector(".transcript__content")!;
      const needed = banner.bottom - transcript.getBoundingClientRect().top;
      const clearance = Math.min(
        Number.parseFloat(getComputedStyle(content).paddingTop),
        Number.parseFloat(getComputedStyle(transcript).scrollPaddingTop),
      );
      return (
        banner.left >= reader.left &&
        banner.right <= reader.right &&
        clearance >= needed - 0.5
      );
    });
  await expect.poll(fitsReader).toBe(true);
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
  const restore = banner.getByRole("button", {
    name: "Restore saved position",
    exact: true,
  });
  try {
    await restore.click();
    await expect(restore).toHaveAttribute("aria-busy", "true");
    await expect(restore).toBeDisabled();
    await expect.poll(fitsReader).toBe(true);
  } finally {
    release();
  }
  await expect(banner.getByRole("alert")).toHaveText(diagnostic);
  await expect(restore).toBeEnabled();
  await page.setViewportSize({ width: 320, height: 900 });
  const close = page.getByRole("button", { name: "Close context pane" });
  if (await close.isVisible()) await close.click();
  await expect.poll(fitsReader).toBe(true);
  expect(
    await banner.getByRole("alert").evaluate(textOverflowsInlineBounds),
  ).toBe(false);
  await page.unroute("**/api/branches/navigate");
  await restore.click();
  await expect(banner).toHaveCount(0);
});
