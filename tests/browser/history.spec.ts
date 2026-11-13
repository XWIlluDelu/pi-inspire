import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ActiveSnapshot } from "../../shared/contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { hostRequest } from "./support/host-request";
import {
  openFixtureSession,
  openHistoryPane,
  pairedPage,
  reloadSession,
} from "./support/navigation";
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

async function inspect(history: Locator, text: string, id: string) {
  await history.getByRole("textbox", { name: "Search this branch" }).fill(text);
  await history.getByRole("button", { name: "Search", exact: true }).click();
  await history
    .getByRole("button", { name: /^Turn \d+:/ })
    .first()
    .click();
  await history
    .locator(`[data-history-entry="${id}"]`)
    .getByRole("button", { name: "Read full entry" })
    .click();
}

test("chooses an alternate native route from the title menu without moving Pi", async ({
  page,
}) => {
  await connectCalibration(page);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep the unsent draft");
  await page.getByRole("button", { name: /^Session actions:/ }).click();
  await page.getByRole("menuitem", { name: "Switch branch…" }).click();
  const history = page.getByRole("region", { name: "Turn history" });
  await history.getByRole("button", { name: "Earlier", exact: true }).click();
  await history.getByRole("button", { name: "Other routes (2)" }).click();
  await history
    .getByRole("group", { name: "Routes from this point" })
    .getByRole("button", { name: /alternate calibration/ })
    .click();
  await expect(history.getByText(/amber reference is retained/)).toBeVisible();
  await expect(composer).toHaveValue("Keep the unsent draft");
  await history.getByRole("button", { name: "Live", exact: true }).click();
  await expect(
    page.getByRole("log").getByText(/amber reference is retained/),
  ).toHaveCount(0);
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
  await inspect(history, "Compare the calibration strategies", "history-u-0");
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
  await page.route("**/api/history?kind=entry&**", async (route) => {
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
    if (
      !(await history.getByRole("link", { name: "external docs" }).isVisible())
    )
      await inspect(
        history,
        "Compare the calibration strategies",
        "history-u-0",
      );
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

  const history = await openHistoryPane(page);
  await inspect(
    history,
    "native-shell-excluded-result",
    "history-shell-excluded",
  );
  const shellPreview = history.getByRole("region", {
    name: "Shell record preview",
  });
  await expect(shellPreview).toContainText("Excluded from context");

  await inspect(history, fullOutput, "history-shell-included");
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
  await inspect(history, "Review calibration run 598", "history-u-598");
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
  const source: ActiveSnapshot = await (
    await hostRequest(page).get(
      "/api/snapshot?detail=fixture-calibration-history",
    )
  ).json();
  const active = source.active!;
  const copy = await hostRequest(page).post("/api/branches/clone", {
    data: {
      sessionId: active.sessionId,
      viewId: active.transcriptPage.viewId,
      targetId: active.durableLeafId,
    },
  });
  expect(copy.ok()).toBe(true);
  await reloadSession(page, (await copy.json()).sessionId);
  page.on("dialog", (dialog) => void dialog.accept());
  const history = await openHistoryPane(page);
  await inspect(history, "Review calibration run 598", "history-u-598");
  await history
    .getByRole("button", { name: "Edit in this session", exact: true })
    .click();
  const banner = page.getByRole("region", { name: "Earlier continuation" });
  await expect(banner).toBeVisible();
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
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
