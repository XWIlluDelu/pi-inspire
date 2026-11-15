import { expect, test } from "@playwright/test";
import { routeSnapshots } from "./support/host-events";
import { rejectOperation } from "./support/host-operations";
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
    await routeSnapshots(page, {});
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
      const { attachmentIds } = route.request().postDataJSON();
      expect(attachmentIds).toHaveLength(1);
      requested();
      await responseGate;
      await rejectOperation(route, "prompt", {
        status: 409,
        message: "The prompt was not delivered.",
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
  await input.fill(repeated);
  try {
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(input).toHaveValue("");
    await input.fill(repeated);
    await openFixtureSession(page, /Formula rendering and spectral analysis/);
    await expect(input).toHaveValue("other session draft");
  } finally {
    release();
  }
  await delayed;
  await expect(input).toHaveValue("other session draft");
  await openFixtureSession(page, /Review extension event lifecycle/);
  await expect(input).toHaveValue(repeated);
  const historyDraft = `\n${draft}`;
  await input.fill(historyDraft);
  await input.press("ArrowUp");
  await expect(input).toHaveValue(historyDraft);
  const historyDialog = page.getByRole("dialog", { name: "Input history" });
  await input.press("Alt+ArrowUp");
  await expect(
    historyDialog.getByRole("radio", { name: repeated }).first(),
  ).toBeVisible();
  await historyDialog.getByRole("radio", { name: repeated }).first().check();
  await expect(input).toHaveValue(historyDraft);
  await historyDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(input).toHaveValue(historyDraft);
  await expect(input).toBeFocused();
  await input.fill("send and do not resurrect");
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/prompt") && response.status() === 202,
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await accepted;
  await expect(input).toHaveValue("");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const first = page.getByRole("textbox", { name: "First message" });
  await first.fill("separate start-surface draft");
  await page.reload();
  await expect(first).toHaveValue("separate start-surface draft");
  await first.fill("");
});

test("composer expansion preserves selection and artifacts", async ({
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
  await expect(expand).toBeVisible();
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
  await collapse.press("Enter");
  await expect(input).toBeFocused();
  await expect(expand).toBeVisible();
  await expect.poll(inputOverflow).toBeGreaterThan(1);
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
    await expect(expand).toBeVisible();
  });
});
