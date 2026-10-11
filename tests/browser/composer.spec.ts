import { expect, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

test("running halo animates independently and retains focus and reduced-motion feedback", async ({ page }) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const composer = page.getByRole("form", { name: "Message composer" });
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.focus();
  const focusedBorder = await composer.evaluate(el => {
    for (const transition of el.getAnimations()) transition.finish();
    return getComputedStyle(el).borderColor;
  });
  // State-to-class mapping is covered by Composer unit tests; isolate this
  // presentation check from the mock worker's short execution lifetime.
  await composer.evaluate(el => el.classList.add("composer--running"));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(composer).toHaveCSS("border-color", focusedBorder);
  const frames = await composer.evaluate(el => {
    const animation = el.getAnimations({ subtree: true }).find(a =>
      a instanceof CSSAnimation && a.animationName === "composer-running-breathe"
    )!;
    animation.pause();
    return [0, 1800].map(time => {
      animation.currentTime = time;
      const halo = getComputedStyle(el, "::before");
      return { opacity: Number(halo.opacity), shadow: halo.boxShadow, pointer: halo.pointerEvents };
    });
  });
  expect(frames[1]!.opacity).toBeGreaterThan(frames[0]!.opacity);
  expect(frames[0]!.shadow).toBe(frames[1]!.shadow);
  expect(frames[0]!.pointer).toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const staticHalo = await composer.evaluate(el => {
    const halo = getComputedStyle(el, "::before");
    return { animation: halo.animationName, opacity: Number(halo.opacity), shadow: halo.boxShadow };
  });
  expect(staticHalo.animation).toBe("none");
  expect(staticHalo.opacity).toBeGreaterThan(0);
  expect(staticHalo.shadow).not.toBe("none");
  await input.fill("Halo does not intercept editing");
  await expect(input).toBeFocused();
  await composer.evaluate(el => el.classList.remove("composer--running"));
  await input.fill("");
});

test("composer text drafts survive reload and stay partitioned through switching, history, sending and clearing", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const draft = "UNSENT_REFRESH_SAFE\n保留 exact draft";
  await input.fill(draft);
  await page.reload();
  await expect(input).toHaveValue(draft);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  await expect(input).toHaveValue("");
  await input.fill("other session draft");
  await openMockSession(page, /Review extension event lifecycle/);
  await expect(input).toHaveValue(draft);
  // Merely browsing history must not overwrite the saved pre-browse draft.
  await input.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(0, 0),
  );
  await input.press("ArrowUp");
  await expect(input).not.toHaveValue(draft);
  await page.reload();
  await expect(input).toHaveValue(draft);
  await input.fill("send and do not resurrect");
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/prompt") && response.status() === 202,
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await accepted;
  await expect(input).toHaveValue("");
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

test("composer expansion follows real wrapping and preserves the same editor, artifacts and completion", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const expand = page.getByRole("button", {
    name: "Expand editor",
    exact: true,
  });
  const collapse = page.getByRole("button", {
    name: "Collapse editor",
    exact: true,
  });
  await input.fill("short input");
  await expect(expand).toHaveCount(0);
  const padding = await input.evaluate((element) => ({
    left: getComputedStyle(element).paddingLeft,
    right: getComputedStyle(element).paddingRight,
  }));
  expect(padding.right).toBe(padding.left);
  const wrapped = "wrapped layout text ".repeat(55);
  await input.fill(wrapped);
  await expect(expand).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(expand).toBeVisible();
  await expect
    .poll(() =>
      input.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 1,
      ),
    )
    .toBe(true);
  expect(
    await input.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingRight),
    ),
  ).toBeGreaterThan(Number.parseFloat(padding.right));
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(expand).toHaveCount(0);
  await page.locator(".composer__file-input").setInputFiles({
    name: "expanded.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment retained"),
  });
  await expect(page.getByText("expanded.txt", { exact: true })).toBeVisible();
  const long = Array.from(
    { length: 60 },
    (_, index) =>
      `Long-form editing line ${index}: preserve the same input and selection.`,
  ).join("\n");
  await input.fill(long);
  await expect(expand).toBeVisible();
  const compactHeight = await input.evaluate((element) => element.clientHeight);
  await input.evaluate((element: HTMLTextAreaElement) => {
    element.dataset.sameEditor = "yes";
    element.focus();
    element.setSelectionRange(4, 17, "backward");
  });
  await expand.click();
  await expect(collapse).toBeVisible();
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((element: HTMLTextAreaElement) => [
      element.dataset.sameEditor,
      element.selectionStart,
      element.selectionEnd,
      element.selectionDirection,
    ]),
  ).toEqual(["yes", 4, 17, "backward"]);
  expect(
    await input.evaluate((element) => element.clientHeight),
  ).toBeGreaterThan(compactHeight + 100);
  await expect(input).toHaveValue(long);
  await expect(page.getByText("expanded.txt", { exact: true })).toBeVisible();
  await collapse.focus();
  await collapse.press("Enter");
  await expect(input).toBeFocused();
  await expect(expand).toBeVisible();
  await expand.click();
  await input.fill("@TerminalSettingsDialog");
  const option = page.getByRole("option", {
    name: "TerminalSettingsDialog.tsx, src/components/TerminalSettingsDialog.tsx",
    exact: true,
  });
  await expect(option).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue(
    '@"src/components/TerminalSettingsDialog.tsx" ',
  );
  await expect(collapse).toBeVisible();
  await input.fill("/model");
  await expect(
    page.getByRole("listbox", { name: "Slash command completions" }),
  ).toBeVisible();
  await input.press("Escape");
  await expect(
    page.getByRole("listbox", { name: "Slash command completions" }),
  ).toHaveCount(0);
  await expect(collapse).toBeVisible();
  await input.fill("short again");
  await expect(collapse).toBeVisible();
  await collapse.click();
  await expect(expand).toHaveCount(0);
  await expect(collapse).toHaveCount(0);
  await expect(input).toHaveValue("short again");
  await expect(page.getByText("expanded.txt", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New session", exact: true }).click();
  const first = page.getByRole("textbox", { name: "First message" });
  await expect(expand).toHaveCount(0);
  await first.fill(long);
  await expect(expand).toBeVisible();
  const firstCompact = await first.evaluate((element) => element.clientHeight);
  await expand.click();
  expect(
    await first.evaluate((element) => element.clientHeight),
  ).toBeGreaterThan(firstCompact);
  await first.fill("short first message");
  await expect(collapse).toBeVisible();
  await collapse.click();
  await expect(expand).toHaveCount(0);
  await first.fill("");

  const touchContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const touch = await touchContext.newPage();
    await pairedPage(touch);
    await touch.getByRole("button", { name: "Toggle navigation" }).click();
    await openMockSession(touch, /Formula rendering and spectral analysis/);
    const touchInput = touch.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await touchInput.fill("short touch input");
    expect(
      await touchInput.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.paddingLeft === style.paddingRight;
      }),
    ).toBe(true);
    await touchInput.fill(long);
    const touchExpand = touch.getByRole("button", {
      name: "Expand editor",
      exact: true,
    });
    await expect(touchExpand).toBeVisible();
    const bounds = await touchExpand.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(
      await touchInput.evaluate(
        (element) => getComputedStyle(element).paddingRight,
      ),
    ).toBe("48px");
    await touchExpand.tap();
    await expect(
      touch.getByRole("button", { name: "Collapse editor", exact: true }),
    ).toBeVisible();
    await expect(touchInput).toBeFocused();
    await touchInput.fill("touch multiline");
    await touchInput.press("Enter");
    await expect(touchInput).toHaveValue("touch multiline\n");
    await touch
      .getByRole("button", { name: "Collapse editor", exact: true })
      .tap();
    await expect(
      touch.getByRole("button", { name: "Expand editor", exact: true }),
    ).toHaveCount(0);
    expect(
      await touchInput.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.paddingLeft === style.paddingRight;
      }),
    ).toBe(true);
  } finally {
    await touchContext.close();
  }
});
