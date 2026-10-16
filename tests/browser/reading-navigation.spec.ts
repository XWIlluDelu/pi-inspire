import { expect, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

for (const narrow of [false, true]) {
  test(`floating reading controls preserve geometry and focus order on ${narrow ? "narrow" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      narrow ? { width: 390, height: 844 } : { width: 1440, height: 960 },
    );
    await pairedPage(page);
    if (narrow)
      await page.getByRole("button", { name: "Toggle navigation" }).click();
    await openMockSession(page, /Formula rendering and spectral analysis/);
    const log = page.getByRole("log");
    const wrap = page.locator(".transcript-wrap");
    const latest = page.getByRole("button", { name: "Jump to latest" });
    const search = page.getByRole("searchbox", { name: "Search conversation" });
    await expect(
      page.getByRole("heading", { name: "A compact result" }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    // Floating controls leave the entire transcript scrollport available.
    const geometry = () =>
      log.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const parent = element.parentElement!.getBoundingClientRect();
        return {
          top: bounds.top,
          height: bounds.height,
          wrapTop: parent.top,
          wrapHeight: parent.height,
        };
      });
    const original = await geometry();
    expect(original.top).toBe(original.wrapTop);
    expect(original.height).toBe(original.wrapHeight);

    // Prompt Map mounts before the log: its node subscription must place the gutter initially.
    if (!narrow) {
      const mapBox = (await page.locator(".prompt-map").boundingBox())!;
      const logBox = (await log.boundingBox())!;
      const columnBox = (await log
        .locator(".transcript__column")
        .first()
        .boundingBox())!;
      expect(mapBox.x).toBeGreaterThan(logBox.x);
      expect(mapBox.x + mapBox.width).toBeLessThan(columnBox.x);
    }

    await log.hover();
    await page.mouse.wheel(0, -2000);
    await expect(latest).toBeVisible();
    await expect(latest).toHaveText("Jump to latest");
    await expect(latest.locator("svg")).toHaveCount(0);
    expect(await geometry()).toEqual(original);
    const latestBox = (await latest.boundingBox())!;
    const logBox = (await log.boundingBox())!;
    expect(
      Math.abs(
        latestBox.x + latestBox.width / 2 - (logBox.x + logBox.width / 2),
      ),
    ).toBeLessThan(1);
    expect(latestBox.y + latestBox.height).toBeLessThan(
      logBox.y + logBox.height,
    );
    expect(latestBox.y).toBeGreaterThan(logBox.y + logBox.height / 2);

    const anchor = () =>
      log.evaluate((element) => ({
        scroll: element.scrollTop,
        rowTop: element
          .querySelector("[data-transcript-row]")!
          .getBoundingClientRect().top,
      }));
    const beforeSearch = await anchor();
    if (narrow)
      await page
        .getByRole("button", { name: "Open conversation search" })
        .click();
    else await search.focus();
    await expect(search).toBeFocused();
    expect(await anchor()).toEqual(beforeSearch);
    expect(await geometry()).toEqual(original);
    const searchBox = (await page.getByRole("search").boundingBox())!;
    expect(searchBox.y).toBeGreaterThan(logBox.y);
    expect(searchBox.y + searchBox.height).toBeLessThan(
      logBox.y + logBox.height,
    );
    if (narrow) {
      await page
        .getByRole("button", { name: "Close conversation search" })
        .click();
      await expect(
        page.getByRole("button", { name: "Open conversation search" }),
      ).toBeFocused();
      await page
        .getByRole("button", { name: "Open prompt navigation" })
        .click();
      await expect(page.locator(".prompt-map")).toBeVisible();
      expect(await anchor()).toEqual(beforeSearch);
      expect(await geometry()).toEqual(original);
      await page
        .getByRole("button", { name: "Open prompt map" })
        .press("Escape");
      await expect(
        page.getByRole("button", { name: "Open prompt navigation" }),
      ).toBeFocused();
    }

    const fold = log.locator("[data-activity-fold]").first();
    await fold
      .getByRole("button", { name: "Expand assistant activity", exact: true })
      .click();
    await fold
      .getByRole("button", { name: "Expand read tool", exact: true })
      .click();
    await expect(
      fold.getByText("def window(samples):", { exact: false }),
    ).toBeVisible();
    await expect(latest).toBeVisible();

    // Actual Tab traversal: top utilities, then message content, then the bottom Latest control.
    await wrap.focus();
    await page.keyboard.press("Tab");
    await expect(
      narrow
        ? page.getByRole("button", { name: "Open prompt navigation" })
        : page.getByRole("combobox", { name: "Search scope" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      narrow
        ? page.getByRole("button", { name: "Open conversation search" })
        : search,
    ).toBeFocused();
    let reachedMessages = false;
    let visitedPromptMap = narrow;
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => ({
        message: !!document.activeElement?.closest(".transcript"),
        latest: !!document.activeElement?.closest(".jump-to-latest"),
        promptMap: !!document.activeElement?.closest("[data-prompt-map]"),
      }));
      expect(focus.latest).toBe(false);
      visitedPromptMap ||= focus.promptMap;
      if (focus.message) {
        reachedMessages = true;
        break;
      }
    }
    expect(reachedMessages).toBe(true);
    expect(visitedPromptMap).toBe(true);
    await log.locator("button, a[href]").last().focus();
    await page.keyboard.press("Tab");
    await expect(latest).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    expect(
      await log.evaluate((element) => element.contains(document.activeElement)),
    ).toBe(true);

    await latest.click();
    await expect(latest).toBeHidden();
    await expect
      .poll(() =>
        log.evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    expect(await geometry()).toEqual(original);

    if (!narrow) {
      await page.setViewportSize({ width: 1024, height: 768 });
      const context = page.locator("#context-pane");
      if (!(await context.isVisible()))
        await page
          .getByRole("button", { name: "Toggle resources panel" })
          .click();
      await expect(context).toBeVisible();
      const insets = await wrap.evaluate((element) => {
        const center = element.getBoundingClientRect();
        const search = element
          .querySelector(".transcript-search")!
          .getBoundingClientRect();
        return {
          left: search.left - center.left,
          right: center.right - search.right,
        };
      });
      expect(insets.left).toBeGreaterThanOrEqual(23);
      expect(insets.right).toBeGreaterThanOrEqual(23);
    }
  });
}

test("prompt map navigates user turns and adapts to the narrow workbench", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Prompt map long-session fixture/);
  await page.setViewportSize({ width: 1_280, height: 1_400 });
  const transcript = page.locator(".transcript");
  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  const map = page.getByRole("navigation", { name: "User prompt navigation" });
  const previous = page.locator(".prompt-map__step--previous");
  const next = page.locator(".prompt-map__step--next");
  await expect(map).toBeVisible();
  await expect(next).toBeDisabled();
  const ticks = map.locator("[data-prompt-ordinal]");
  await expect(ticks).toHaveCount(12);
  const restingOrdinals = await ticks.evaluateAll((elements) =>
    elements.map((element) =>
      Number((element as HTMLElement).dataset.promptOrdinal),
    ),
  );
  expect(restingOrdinals).toEqual(
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
  await expect(map.locator(".prompt-map__tick--active")).toHaveAttribute(
    "data-prompt-ordinal",
    "12",
  );
  await page.getByRole("button", { name: "Open prompt map" }).hover();
  await expect(page.locator(".prompt-map__list")).toBeVisible();
  await page.locator(".topbar__title").hover();
  await expect(page.locator(".prompt-map__list")).toBeHidden();
  await page.getByRole("button", { name: "Open prompt map" }).click();
  await expect(page.locator(".prompt-map__list")).toBeVisible();
  const list = page.locator(".prompt-map__list");
  await expect
    .poll(() =>
      list.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  await list.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const firstPrompt = page.locator(".prompt-map__turn").first();
  await expect(firstPrompt).toBeVisible();
  await firstPrompt.click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.locator(".topbar__title").hover();
  await expect(
    page.getByRole("button", { name: "Open prompt map" }),
  ).toBeVisible();
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();

  await next.click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect(previous).toBeDisabled();

  await page.getByRole("button", { name: "Open prompt map" }).click();
  await expect(list).toBeVisible();
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const lastPrompt = page.getByRole("button", {
    name: /^13\. Prompt map fixture turn 13/,
  });
  await expect(lastPrompt).toBeVisible();
  await lastPrompt.click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.locator(".topbar__title").hover();
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();

  await page.getByRole("button", { name: "Open prompt map" }).click();
  await expect(list).toBeVisible();
  await list.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.locator(".prompt-map__turn").first().click();
  await page.locator(".topbar__title").hover();
  await expect(previous).toBeDisabled();

  await page.setViewportSize({ width: 390, height: 780 });
  await expect(map).toBeHidden();
  const searchLauncher = page.getByRole("button", {
    name: "Open conversation search",
  });
  const promptLauncher = page.getByRole("button", {
    name: "Open prompt navigation",
  });
  await expect(searchLauncher).toBeVisible();
  await expect(promptLauncher).toBeVisible();
  const launcherBoxes = await Promise.all([
    searchLauncher.boundingBox(),
    promptLauncher.boundingBox(),
  ]);
  expect(
    launcherBoxes.every(
      (box) => box !== null && box.width >= 44 && box.height >= 44,
    ),
  ).toBe(true);

  await searchLauncher.click();
  const mobileSearch = page.getByRole("searchbox", {
    name: "Search conversation",
  });
  await expect(mobileSearch).toBeVisible();
  await expect(mobileSearch).toBeFocused();
  await mobileSearch.fill("Prompt map fixture turn 13");
  await expect(page.getByLabel("Transcript search matches")).toContainText(
    "1 match",
  );
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole("combobox", { name: "Search scope" }).click();
  await page.getByRole("option", { name: "Model", exact: true }).click();
  await expect(mobileSearch).toBeVisible();
  await expect(mobileSearch).toHaveValue("Prompt map fixture turn 13");
  await expect(page.getByRole("combobox", { name: "Search scope" })).toHaveText(
    "Model",
  );
  const matches = page.getByLabel("Transcript search matches");
  await expect(matches).toHaveText("No matches");
  expect(
    await matches.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    (await page.locator(".transcript-search__icon").boundingBox())!.width,
  ).toBe(14);
  await page.getByRole("button", { name: "Close conversation search" }).click();
  await expect(searchLauncher).toBeVisible();

  await promptLauncher.click();
  await expect(map).toBeVisible();
  const mobileControls = await map
    .locator(".prompt-map__step")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      }),
    );
  expect(
    mobileControls.every(
      (control) => control.width >= 44 && control.height >= 44,
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Open prompt map" }).click();
  await expect(list).toBeVisible();
  const overflow = await page
    .locator("html")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

for (const viewport of [
  { width: 1440, height: 960 },
  { width: 390, height: 844 },
  { width: 320, height: 700 },
  { width: 844, height: 390 },
]) {
  test(`reading scroll thumb stays outside content and inside the scrollport at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairedPage(page);
    await openMockSession(page, /Formula rendering and spectral analysis/);
    const log = page.getByRole("log");
    const rail = page.locator(".transcript-wrap > .srail");
    const thumb = rail.locator(".srail__thumb");
    await log.locator("pre").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await expect(rail).toBeVisible();

    for (const fraction of [0, 0.5, 1]) {
      await log.evaluate((el, value) => {
        el.scrollTop = (el.scrollHeight - el.clientHeight) * value;
      }, fraction);
      await expect
        .poll(() =>
          page.locator(".transcript-wrap").evaluate((wrap) => {
            const viewport = wrap
              .querySelector(".transcript")!
              .getBoundingClientRect();
            const column = wrap
              .querySelector(".transcript__column")!
              .getBoundingClientRect();
            const rail = wrap.querySelector(".srail")!.getBoundingClientRect();
            const thumb = wrap
              .querySelector(".srail__thumb")!
              .getBoundingClientRect();
            return {
              clearOfContent: thumb.left >= column.right + 1,
              insideHorizontalGutter: thumb.right <= viewport.right - 1,
              insideVerticalScrollport:
                rail.top >= viewport.top &&
                rail.bottom <= viewport.bottom &&
                thumb.top >= viewport.top &&
                thumb.bottom <= viewport.bottom,
            };
          }),
        )
        .toEqual({
          clearOfContent: true,
          insideHorizontalGutter: true,
          insideVerticalScrollport: true,
        });
    }

    // This fixture's visible code intersects the thumb vertically on a phone.
    // Its trailing text must receive pointer/selection input, not the invisible grab band.
    if (viewport.width === 390) {
      await expect
        .poll(() =>
          log.evaluate((el) => {
            const code = el.querySelector("pre")!;
            const bounds = code.getBoundingClientRect();
            const thumb = el
              .parentElement!.querySelector(".srail__thumb")!
              .getBoundingClientRect();
            const top = Math.max(bounds.top, thumb.top);
            const bottom = Math.min(bounds.bottom, thumb.bottom);
            return (
              bottom > top &&
              code.contains(
                document.elementFromPoint(bounds.right - 2, (top + bottom) / 2),
              )
            );
          }),
        )
        .toBe(true);
    }

    const beforeDrag = await log.evaluate((el) => el.scrollTop);
    const box = (await thumb.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 32, {
      steps: 4,
    });
    await page.mouse.up();
    await expect
      .poll(() => log.evaluate((el) => el.scrollTop))
      .toBeLessThan(beforeDrag);
    await expect(page.locator("body")).not.toHaveClass(/srail-dragging/);

    const beforeWheel = await log.evaluate((el) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
      return el.scrollTop;
    });
    await thumb.hover();
    await page.mouse.wheel(0, 48);
    await expect
      .poll(() => log.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(beforeWheel);
  });
}
