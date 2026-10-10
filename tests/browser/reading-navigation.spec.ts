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
  });
}
