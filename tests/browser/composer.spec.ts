import { expect, test } from "@playwright/test";
import {
  type ActiveSnapshot,
  PALETTE_PREFERENCES,
} from "../../shared/contracts";
import { renderedColors } from "./support/colors";
import { routeMockSnapshots } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";

for (const touch of [false, true]) {
  test.describe(`failed-delivery recovery · ${touch ? "touch" : "mouse"}`, () => {
    test.use({
      hasTouch: touch,
      deviceScaleFactor: touch ? 2 : 1,
      reducedMotion: "reduce",
    });
    test("distinguishes unavailable Restore without overwriting the current draft", async ({
      page,
    }) => {
      const transport = await routeMockSnapshots(page, {});
      await pairedPage(page);
      await openMockSession(page, /Review extension event lifecycle/);
      let release!: () => void;
      const responseGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requested!: () => void;
      const requestGate = new Promise<void>((resolve) => {
        requested = resolve;
      });
      await page.route("**/api/prompt", async (route) => {
        requested();
        await responseGate;
        await route.fulfill({
          status: 400,
          headers: { "X-Inspire-Authority": transport.authority() },
          json: { error: "The prompt was not delivered." },
        });
      });
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      await input.fill("Retain the failed prompt exactly");
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
      for (const width of [1280, 820, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(row).toBeVisible();
        expect(
          await row.evaluate((el) => el.scrollWidth - el.clientWidth),
        ).toBeLessThanOrEqual(1);
        expect((await restore.boundingBox())!.height).toBeCloseTo(32, 1);
      }
      for (const palette of PALETTE_PREFERENCES)
        for (const theme of ["light", "dark"]) {
          await page.evaluate(
            ({ palette, theme }) =>
              Object.assign(document.documentElement.dataset, {
                palette,
                theme,
              }),
            { palette, theme },
          );
          const inks = await page.evaluate(() => {
            const probe = document.createElement("span");
            document.body.append(probe);
            probe.style.color = "var(--faint)";
            const disabled = getComputedStyle(probe).color;
            probe.style.color = "var(--body)";
            const enabled = getComputedStyle(probe).color;
            probe.remove();
            return { disabled, enabled };
          });
          await expect(restore).toBeDisabled();
          await expect(restore).toHaveCSS("color", inks.disabled);
          const disabled = await renderedColors(restore);
          expect(disabled.contrast).toBeGreaterThanOrEqual(4.5);
          if (!touch) {
            await restore.hover({ force: true });
            expect(
              await restore.evaluate(
                (el) => getComputedStyle(el).backgroundColor,
              ),
            ).toBe("rgba(0, 0, 0, 0)");
          }
          await input.fill("");
          await expect(restore).toBeEnabled();
          await expect(restore).toHaveCSS("color", inks.enabled);
          const enabled = await renderedColors(restore);
          expect(enabled.foreground).not.toEqual(disabled.foreground);
          expect(enabled.contrast).toBeGreaterThanOrEqual(4.5);
          await input.fill("Keep this newer draft");
        }
      await expect(input).toHaveValue("Keep this newer draft");
      await input.fill("");
      if (touch) await restore.tap();
      else await restore.click();
      await expect(input).toHaveValue("Retain the failed prompt exactly");
      await expect(restore).toHaveCount(0);
    });
  });
}

test("composer selectors stay readable in narrow desktop panes without moving or hiding task actions", async ({
  page,
}) => {
  let source: ActiveSnapshot | undefined;
  let envelope: { type: string; detailSessionId?: string } | undefined;
  const transport = await routeMockSnapshots(page, {
    snapshot: (snapshot) => {
      if (snapshot.active) source = structuredClone(snapshot);
    },
    event: (event) => {
      if (event.type === "snapshot" && event.data?.active)
        envelope = { ...event };
    },
  });
  await page.setViewportSize({ width: 1366, height: 768 });
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const toggle = page.getByRole("button", {
    name: "Toggle resources panel",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await expect
    .poll(() => envelope?.detailSessionId)
    .toBe(source!.active!.sessionId);
  const composer = page.getByRole("form", { name: "Message composer" });
  const model = composer.getByRole("button", { name: "Model", exact: true });
  const thinking = composer.getByRole("combobox", { name: "Thinking level" });
  const files = composer.getByRole("button", {
    name: "Add project files",
    exact: true,
  });
  await page.evaluate(() => document.fonts.ready);
  for (const running of [false, true]) {
    if (running) {
      const snapshot = structuredClone(source!);
      snapshot.runState = "running";
      snapshot.active!.isStreaming = true;
      snapshot.sessionStatuses[snapshot.active!.sessionId] = {
        runState: "running",
      };
      transport.send({ ...envelope, unchanged: false, data: snapshot });
      await expect(
        composer.getByRole("button", {
          name: "Abort running task",
          exact: true,
        }),
      ).toBeVisible();
    }
    for (const width of [1366, 1100, 1024, 940, 901]) {
      await page.setViewportSize({ width, height: 768 });
      await expect
        .poll(() =>
          composer
            .locator(".composer__selectors .dropdown__trigger")
            .evaluateAll((fields) =>
              Math.max(
                0,
                ...fields.map((field) => {
                  const value =
                    field.querySelector<HTMLElement>(".dropdown__value")!;
                  const text = value.getBoundingClientRect(),
                    control = field.getBoundingClientRect();
                  return Math.max(
                    value.scrollWidth - value.clientWidth,
                    control.left - text.left,
                    text.right - control.right,
                  );
                }),
              ),
            ),
        )
        .toBeLessThanOrEqual(0.5);
      // The running halo intentionally extends past the form; measure its content row.
      await expect
        .poll(() =>
          composer
            .locator(".composer__meta")
            .evaluate((el) => el.scrollWidth - el.clientWidth),
        )
        .toBe(0);
      for (const action of await composer
        .locator(".composer__meta > button")
        .all()) {
        const bounds = await action.boundingBox(),
          frame = await composer.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(frame!.x);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
          frame!.x + frame!.width + 0.5,
        );
      }
      if (width === 901) {
        const selector = await model.boundingBox(),
          action = await files.boundingBox();
        expect(selector!.y + selector!.height).toBeLessThan(action!.y);
      }
      if (width === 1366) {
        const selector = await model.boundingBox(),
          action = await files.boundingBox();
        expect(
          Math.abs(
            selector!.y + selector!.height / 2 - action!.y - action!.height / 2,
          ),
        ).toBeLessThanOrEqual(0.5);
      }
    }
    const sends = composer.locator(".composer__send");
    await expect(sends).toHaveCount(running ? 2 : 1);
    if (running) {
      const controls = await sends.evaluateAll((buttons) =>
        buttons.map((button) => {
          const box = button.getBoundingClientRect();
          return box.y + box.height / 2;
        }),
      );
      expect(Math.abs(controls[0]! - controls[1]!)).toBeLessThanOrEqual(0.5);
    }
    await model.focus();
    await model.press("Enter");
    await expect(page.getByRole("option", { selected: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(model).toBeFocused();
    await thinking.press("Enter");
    await expect(
      page.getByRole("listbox", { name: "Thinking level" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(thinking).toBeFocused();
  }
  await composer
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Keep the same pane-sized editor");
  await expect(
    composer.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Keep the same pane-sized editor");
  // The desktop fix must not move the phone layout's existing wrap threshold.
  await page.setViewportSize({ width: 430, height: 844 });
  await page
    .getByRole("dialog", { name: "Context panel", exact: true })
    .press("Escape");
  for (const [width, display] of [
    [430, "contents"],
    [390, "flex"],
  ] as const) {
    await page.setViewportSize({ width, height: 844 });
    await expect(composer.locator(".composer__selectors")).toHaveCSS(
      "display",
      display,
    );
  }
});

test("running halo animates independently and retains focus and reduced-motion feedback", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const composer = page.getByRole("form", { name: "Message composer" });
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.focus();
  const focusedBorder = await composer.evaluate((el) => {
    for (const transition of el.getAnimations()) transition.finish();
    return getComputedStyle(el).borderColor;
  });
  // State-to-class mapping is covered by Composer unit tests; isolate this
  // presentation check from the mock worker's short execution lifetime.
  await composer.evaluate((el) => el.classList.add("composer--running"));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(composer).toHaveCSS("border-color", focusedBorder);
  const frames = await composer.evaluate((el) => {
    const animation = el
      .getAnimations({ subtree: true })
      .find(
        (a) =>
          a instanceof CSSAnimation &&
          a.animationName === "composer-running-breathe",
      )!;
    animation.pause();
    return [0, 1800].map((time) => {
      animation.currentTime = time;
      const halo = getComputedStyle(el, "::before");
      return {
        opacity: Number(halo.opacity),
        shadow: halo.boxShadow,
        pointer: halo.pointerEvents,
      };
    });
  });
  expect(frames[1]!.opacity).toBeGreaterThan(frames[0]!.opacity);
  expect(frames[0]!.shadow).toBe(frames[1]!.shadow);
  expect(frames[0]!.pointer).toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const staticHalo = await composer.evaluate((el) => {
    const halo = getComputedStyle(el, "::before");
    return {
      animation: halo.animationName,
      opacity: Number(halo.opacity),
      shadow: halo.boxShadow,
    };
  });
  expect(staticHalo.animation).toBe("none");
  expect(staticHalo.opacity).toBeGreaterThan(0);
  expect(staticHalo.shadow).not.toBe("none");
  await input.fill("Halo does not intercept editing");
  await expect(input).toBeFocused();
  await composer.evaluate((el) => el.classList.remove("composer--running"));
  await input.fill("");
});

test("composer text drafts survive reload and stay partitioned through switching, history, sending and clearing", {
  tag: "@cross-browser",
}, async ({ page }) => {
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
