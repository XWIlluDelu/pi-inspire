import { expect, test } from "@playwright/test";
import type { ComposerHistoryPage } from "../../shared/contracts";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import { openFixtureSession, pairedPage } from "./support/navigation";

test.describe("touch recovery", () => {
  test.use({
    hasTouch: true,
    deviceScaleFactor: 2,
    contextOptions: { reducedMotion: "reduce" },
  });
  test("distinguishes unavailable Restore without overwriting the current draft", async ({
    page,
  }) => {
    const transport = await routeSnapshots(page, {});
    await pairedPage(page);
    await openFixtureSession(page, /Review extension event lifecycle/);
    await page.locator(".composer__file-input").setInputFiles({
      name: "failed-draft.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Keep this artifact."),
    });
    await expect(page.locator(".attachment--ready")).toContainText(
      "failed-draft.txt",
    );
    let release!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route("**/api/prompt", async (route) => {
      const { operationId, attachmentIds } = route.request().postDataJSON();
      expect(attachmentIds).toHaveLength(1);
      requested();
      await responseGate;
      await route.fulfill({
        status: 409,
        headers: {
          "X-Inspire-Authority": transport.authority(),
          "X-Inspire-Prompt-Operation": operationId,
          "X-Inspire-Prompt-Outcome": "rejected",
        },
        json: { error: "The prompt was not delivered." },
      });
    });
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    const original = "Retain the failed prompt\nexactly";
    await input.fill("Retain the failed prompt");
    await input.press("Enter");
    await expect(input).toHaveValue("Retain the failed prompt\n");
    await input.pressSequentially("exactly");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await requestGate;
    await input.fill("Keep this newer draft");
    release();
    const restore = page.getByRole("button", {
      name: "Restore",
      exact: true,
    });
    await expect(restore).toBeDisabled();
    const row = page.locator(".composer__failed-delivery");
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(row).toBeVisible();
    expect(
      await row.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    await expect(input).toHaveValue("Keep this newer draft");
    await input.fill("");
    await restore.tap();
    await expect(input).toHaveValue(original);
    await expect(page.locator(".attachment--ready")).toContainText(
      "failed-draft.txt",
    );
    await expect(restore).toHaveCount(0);
    await page.unrouteAll({ behavior: "wait" });
  });
});

test("a narrow running composer keeps model controls and task actions reachable", async ({
  page,
}) => {
  await routeSnapshots(page, {
    snapshot: (body) => {
      const active = body.active;
      if (active?.sessionId !== "fixture-active" || !active.model) return;
      const name =
        "Experimental measurement analysis calibration model with an unusually long display name";
      active.model.name = name;
      for (const model of active.availableModels ?? []) {
        if (model.id === active.model.id) model.name = name;
      }
      body.runState = "running";
      active.isStreaming = true;
      body.sessionStatuses[active.sessionId] = { runState: "running" };
    },
  });
  await page.setViewportSize({ width: 901, height: 768 });
  await pairedPage(page);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  const toggle = page.getByRole("button", { name: "Toggle resources panel" });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  const composer = page.getByRole("form", { name: "Message composer" });
  const model = composer.getByRole("button", { name: "Model", exact: true });
  const thinking = composer.getByRole("combobox", { name: "Thinking level" });
  const attach = composer.getByRole("button", { name: "Add project files" });
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      thinking
        .locator(".dropdown__value")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() =>
      composer
        .locator(".composer__meta")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  const selector = (await model.boundingBox())!;
  expect(selector.y + selector.height).toBeLessThan(
    (await attach.boundingBox())!.y,
  );
  await thinking.press("Enter");
  await expect(
    page.getByRole("listbox", { name: "Thinking level" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(thinking).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Close context pane" }).click();
  await expect(attach).toBeInViewport();
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toBeInViewport();
});

test("a delayed model refusal leaves focus on the closed picker trigger", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  const error = "Model unavailable after selection";
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/control/model", async (route) => {
    await pending;
    await route.fulfill({ status: 409, json: { error } });
  });
  const picker = page.getByRole("button", { name: "Model", exact: true });
  await picker.click();
  const list = page.getByRole("listbox", { name: "Available models" });
  const requested = page.waitForRequest("**/api/control/model");
  try {
    await list.getByRole("option", { selected: false }).first().click();
    await requested;
    await expect(list).toHaveCount(0);
    await expect(picker).toBeFocused();
  } finally {
    release();
  }
  await expect(page.getByText(error, { exact: true })).toBeVisible();
  await expect(picker).toBeFocused();
});

test("running halo animates independently and retains focus and reduced-motion feedback", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  const composer = page.getByRole("form", { name: "Message composer" });
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.focus();
  const focusedBorder = await composer.evaluate((el) => {
    for (const transition of el.getAnimations()) transition.finish();
    return getComputedStyle(el).borderColor;
  });
  // State-to-class mapping is covered by Composer unit tests; isolate this
  // presentation check from the offline provider's short execution lifetime.
  await composer.evaluate((el) => el.classList.add("composer--running"));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(composer).toHaveCSS("border-color", focusedBorder);
  const haloOpacity = await composer.evaluate((el) => {
    const animation = el
      .getAnimations({ subtree: true })
      .find(
        (entry) =>
          entry.effect instanceof KeyframeEffect &&
          entry.effect.pseudoElement === "::before",
      )!;
    animation.pause();
    return [0, 0.5].map((fraction) => {
      animation.currentTime =
        Number(animation.effect!.getComputedTiming().duration) * fraction;
      return Number(getComputedStyle(el, "::before").opacity);
    });
  });
  expect(haloOpacity[1]!).toBeGreaterThan(haloOpacity[0]!);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const staticHalo = await composer.evaluate((el) => {
    const halo = getComputedStyle(el, "::before");
    return { animation: halo.animationName, opacity: Number(halo.opacity) };
  });
  expect(staticHalo.animation).toBe("none");
  expect(staticHalo.opacity).toBeGreaterThan(0);
});

test("composer text drafts survive reload and stay partitioned through switching, history, sending and clearing", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const draft = "UNSENT_REFRESH_SAFE\n保留 exact draft";
  await input.fill(draft);
  await page.reload();
  await expect(input).toHaveValue(draft);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  await expect(input).toHaveValue("");
  await input.fill("other session draft");
  await openFixtureSession(page, /Review extension event lifecycle/);
  await expect(input).toHaveValue(draft);
  const priorHistory: ComposerHistoryPage = await (
    await hostRequest(page).get(
      "/api/composer/history?sessionId=fixture-history",
    )
  ).json();
  const priorPrompt = priorHistory.entries[0]!.text;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/prompt",
    async (route) => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  const delayed = page.waitForResponse(
    (response) => response.url().endsWith("/api/prompt") && response.ok(),
  );
  const repeated = "Same input typed again before confirmation";
  let otherAttachmentId = "";
  await input.fill(repeated);
  try {
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(input).toHaveValue("");
    await input.fill(repeated);
    await openFixtureSession(page, /Formula rendering and spectral analysis/);
    await expect(input).toHaveValue("other session draft");
    const uploaded = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/attachments") &&
        response.ok(),
    );
    await page.locator(".composer__file-input").setInputFiles({
      name: "other-draft.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Another session's attachment."),
    });
    otherAttachmentId = (await (await uploaded).json()).attachments[0].id;
  } finally {
    release();
  }
  await delayed;
  await expect(input).toHaveValue("other session draft");
  await expect(page.locator(".attachment--ready")).toContainText(
    "other-draft.txt",
  );
  await openFixtureSession(page, /Review extension event lifecycle/);
  await expect(input).toHaveValue(repeated);
  await expect(page.getByText("other-draft.txt", { exact: true })).toHaveCount(
    0,
  );
  await page.locator(".composer__file-input").setInputFiles({
    name: "source-draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Belongs to the source session."),
  });
  await expect(page.locator(".attachment--ready")).toContainText(
    "source-draft.txt",
  );
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  const otherSent = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/prompt") && response.status() === 202,
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  expect((await otherSent).request().postDataJSON()).toMatchObject({
    message: "other session draft",
    attachmentIds: [otherAttachmentId],
  });
  await openFixtureSession(page, /Review extension event lifecycle/);
  await expect(page.locator(".attachment--ready")).toContainText(
    "source-draft.txt",
  );
  const historyDraft = `\n${draft}`;
  await input.fill(historyDraft);
  await input.press("ArrowUp");
  await expect(input).toHaveValue(historyDraft);
  await input.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(0, 0),
  );
  await input.press("ArrowUp");
  await expect(input).toHaveValue(repeated);
  await input.press("ArrowUp");
  await expect(input).toHaveValue(priorPrompt);
  await input.press("ArrowDown");
  await expect(input).toHaveValue(repeated);
  await input.press("ArrowDown");
  await expect(input).toHaveValue(historyDraft);
  await expect
    .poll(() =>
      input.evaluate((element: HTMLTextAreaElement) => element.selectionStart),
    )
    .toBe(0);
  await expect(page.locator(".attachment--ready")).toContainText(
    "source-draft.txt",
  );
  await input.press("ArrowUp");
  await expect(input).toHaveValue(repeated);
  await page.reload();
  await expect(input).toHaveValue(historyDraft);
  await input.fill("send and do not resurrect");
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/prompt") && response.status() === 202,
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await accepted;
  await expect(input).toHaveValue("");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("send and do not resurrect");
  await page.reload();
  await expect(input).toHaveValue("");
  await input.fill("explicitly removed");
  await input.fill("");
  await page.reload();
  await expect(input).toHaveValue("");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const first = page.getByRole("textbox", { name: "First message" });
  await first.fill("separate start-surface draft");
  await page.reload();
  await expect(first).toHaveValue("separate start-surface draft");
  await first.fill("");
});

test("composer expansion follows wrapping and preserves selection, artifacts and completion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const expand = page.getByRole("button", { name: "Expand editor" });
  const collapse = page.getByRole("button", { name: "Collapse editor" });
  const inputOverflow = () =>
    input.evaluate((element) => element.scrollHeight - element.clientHeight);
  const wrapped = "wrapped layout text ".repeat(55);
  await input.fill(wrapped);
  await expect(expand).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(expand).toBeVisible();
  await expect.poll(inputOverflow).toBeGreaterThan(1);
  const compactHeight = (await input.boundingBox())!.height;
  await page.locator(".composer__file-input").setInputFiles({
    name: "expanded.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment retained"),
  });
  const attachment = page.getByText("expanded.txt", { exact: true });
  await expect(attachment).toBeVisible();
  await input.evaluate((element: HTMLTextAreaElement) => {
    element.focus();
    element.setSelectionRange(4, 17, "backward");
  });
  await expand.click();
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
      el.selectionDirection,
    ]),
  ).toEqual([4, 17, "backward"]);
  expect((await input.boundingBox())!.height).toBeGreaterThan(compactHeight);
  await expect(input).toHaveValue(wrapped);
  await input.fill("@TerminalSettingsDialog");
  await expect(
    page.getByRole("option", { name: /TerminalSettingsDialog\.tsx/ }),
  ).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue(
    '@"src/components/TerminalSettingsDialog.tsx" ',
  );
  await collapse.press("Enter");
  await expect(input).toBeFocused();
  await expect(expand).toHaveCount(0);
  await expect.poll(inputOverflow).toBe(0);
  await expect(attachment).toBeVisible();
});

test.describe("touch expansion", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("expands the first-message editor and keeps Return available for prose", async ({
    page,
  }) => {
    await pairedPage(page);
    const input = page.getByRole("textbox", { name: "First message" });
    await input.fill("Long first message\n".repeat(60));
    const expand = page.getByRole("button", { name: "Expand editor" });
    const compactHeight = (await input.boundingBox())!.height;
    await expand.tap();
    await expect(input).toBeFocused();
    expect((await input.boundingBox())!.height).toBeGreaterThan(compactHeight);
    await input.fill("touch multiline");
    await input.press("Enter");
    await expect(input).toHaveValue("touch multiline\n");
    await page.getByRole("button", { name: "Collapse editor" }).tap();
    await expect(expand).toHaveCount(0);
  });
});
