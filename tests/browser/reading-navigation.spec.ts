import { expect, test } from "@playwright/test";
import { PALETTE_PREFERENCES } from "../../shared/contracts";
import { renderedColors } from "./support/colors";
import { routeMockSnapshots } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";
import { firstTextBaseline } from "./support/text-baseline";

// These suites own mocked Host responses, not Service Worker fetch handling.
test.use({ serviceWorkers: "block" });

test("prompt outline metadata stays readable and shares the text baseline without changing row height", {
  tag: "@platform-ui",
}, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const count = (ordinal: number) =>
    ordinal % 3 === 2 ? 12 : (ordinal % 3) + 1;
  await routeMockSnapshots(page, {
    snapshot(snapshot) {
      let ordinal = 0;
      for (const record of snapshot.active?.transcriptPage.messages ?? []) {
        const message = record as { role?: string; content: unknown };
        if (message.role !== "user" || typeof message.content !== "string")
          continue;
        message.content = [
          { type: "text", text: message.content },
          ...Array.from({ length: count(ordinal++) }, () => ({
            type: "image",
            mimeType: "image/png",
            data: pixel,
          })),
        ];
      }
    },
  });
  await page.route("**/api/transcript/user-turns?**", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    for (const turn of data.turns) turn.attachmentCount = count(turn.ordinal);
    await route.fulfill({ response, json: data });
  });
  await pairedPage(page);
  await openMockSession(page, /Prompt map long-session fixture/);
  await page.addStyleTag({
    content: "*{transition:none!important;animation:none!important}",
  });
  await page.evaluate(() => document.fonts.ready);
  const map = page.locator(".prompt-map");
  const list = map.locator(".prompt-map__list");
  async function openOutline() {
    if (!(await map.isVisible()))
      await page
        .getByRole("button", { name: "Open prompt navigation", exact: true })
        .click();
    const toggle = page.getByRole("button", {
      name: "Open prompt map",
      exact: true,
    });
    if (await toggle.isVisible()) await toggle.click();
    await expect(list).toBeVisible();
    const box = (await map.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + 2);
  }
  await openOutline();
  for (const palette of PALETTE_PREFERENCES)
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        ({ palette, theme }) => {
          document.documentElement.dataset.palette = palette;
          document.documentElement.dataset.theme = theme;
        },
        { palette, theme },
      );
      for (const row of [
        map.locator(".prompt-map__turn:not([aria-current])").first(),
        map.locator(".prompt-map__turn[aria-current]"),
      ]) {
        const ordinal = row.locator(".prompt-map__ordinal");
        const attachments = row.locator(".prompt-map__attachments");
        expect(
          await attachments.evaluate((el) => getComputedStyle(el).fontSize),
        ).toBe(await ordinal.evaluate((el) => getComputedStyle(el).fontSize));
        for (const metadata of [ordinal, attachments]) {
          expect(
            await metadata.evaluate((el) => getComputedStyle(el).opacity),
          ).toBe("1");
          expect(
            (await renderedColors(metadata)).contrast,
            `${palette} ${theme}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await openOutline();
    const rows = map.locator(".prompt-map__turn");
    await expect(
      rows.filter({ hasText: /12 attachments/ }).first(),
    ).toBeAttached();
    const columns = await rows.evaluateAll((rows) =>
      rows.map((row) => {
        const frame = row.getBoundingClientRect();
        const ordinal = row
          .querySelector(".prompt-map__ordinal")!
          .getBoundingClientRect();
        const snippet = row
          .querySelector(".prompt-map__snippet")!
          .getBoundingClientRect();
        return { right: ordinal.right - frame.x, left: snippet.left - frame.x };
      }),
    );
    for (const edge of ["right", "left"] as const)
      expect(
        Math.max(...columns.map((column) => column[edge])) -
          Math.min(...columns.map((column) => column[edge])),
      ).toBeLessThanOrEqual(0.5);
    for (const row of await rows.all()) {
      const snippet = await row
        .locator(".prompt-map__snippet")
        .evaluate(firstTextBaseline, ".prompt-map__turn");
      for (const metadata of [
        ".prompt-map__ordinal",
        ".prompt-map__attachments",
      ]) {
        const value = await row
          .locator(metadata)
          .evaluate(firstTextBaseline, ".prompt-map__turn");
        expect(Math.abs(value! - snippet!)).toBeLessThanOrEqual(0.5);
      }
      expect((await row.boundingBox())!.height).toBe(38);
      expect(
        await row.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
    }
    await list.focus();
    await page.keyboard.press("Tab");
    await expect(rows.first()).toBeFocused();
    await expect(rows.first()).toBeInViewport();
    const ring = await rows.first().evaluate((el) => {
      const style = getComputedStyle(el),
        frame = el.getBoundingClientRect(),
        clip = el.closest(".prompt-map__list")!.getBoundingClientRect();
      const outset = Math.max(
        0,
        Number.parseFloat(style.outlineOffset) +
          Number.parseFloat(style.outlineWidth),
      );
      return {
        visible: el.matches(":focus-visible"),
        left: frame.left - outset - clip.left,
        right: clip.right - frame.right - outset,
        top: frame.top - outset - clip.top,
      };
    });
    expect(ring.visible).toBe(true);
    for (const edge of [ring.left, ring.right, ring.top])
      expect(edge).toBeGreaterThanOrEqual(-0.5);
    await list.press("Escape");
    const toggle = page.getByRole("button", {
      name: "Open prompt map",
      exact: true,
    });
    await expect(toggle).toBeFocused();
    if (width <= 700) {
      await toggle.press("Escape");
      await expect(
        page.getByRole("button", {
          name: "Open prompt navigation",
          exact: true,
        }),
      ).toBeFocused();
    }
  }
});

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

    // Align the code with the thumb explicitly: previous conversations and font
    // metrics must not decide whether this hit-testing scenario is exercised.
    // Its trailing text must receive input, not the invisible grab band.
    if (viewport.width === 390) {
      // Leave Follow latest through real input before positioning earlier text.
      const bottom = await log.evaluate((el) => el.scrollTop);
      await log.hover();
      await page.mouse.wheel(0, -120);
      await expect
        .poll(() => log.evaluate((el) => el.scrollTop))
        .toBeLessThan(bottom);
      await log.evaluate((el) => {
        const code = el.querySelector("pre")!.getBoundingClientRect();
        const rail = el.parentElement!.querySelector(".srail")!;
        const railBounds = rail.getBoundingClientRect();
        const thumb = rail
          .querySelector(".srail__thumb")!
          .getBoundingClientRect();
        const viewport = el.getBoundingClientRect();
        const range = el.scrollHeight - el.clientHeight;
        const codeCenter =
          el.scrollTop + code.top - viewport.top + code.height / 2;
        const thumbOrigin = railBounds.top - viewport.top + thumb.height / 2;
        const thumbTravel = railBounds.height - thumb.height;
        el.scrollTop = (codeCenter - thumbOrigin) / (1 + thumbTravel / range);
      });
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
            return {
              overlaps: bottom > top,
              receivesPointer: code.contains(
                document.elementFromPoint(bounds.right - 2, (top + bottom) / 2),
              ),
            };
          }),
        )
        .toEqual({ overlaps: true, receivesPointer: true });
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
