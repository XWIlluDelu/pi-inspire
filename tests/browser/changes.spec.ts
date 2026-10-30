import { expect, test } from "@playwright/test";
import type { GitDiffResponse } from "../../shared/contracts";

// Files and Changes share the contextual navigation and reading surface.
import { focusRingClipping } from "./support/focus-bounds";
import { openMockSession, pairedPage } from "./support/navigation";

for (const touch of [false, true]) {
  test.describe(`resource navigation focus · ${touch ? "coarse" : "fine"} pointer`, () => {
    test.use({
      viewport: { width: 1366, height: 768 },
      hasTouch: touch,
      deviceScaleFactor: touch ? 2 : 1,
      reducedMotion: "reduce",
    });
    test("keeps file navigation and shared path-copy outlines inside clipped regions", async ({
      page,
    }) => {
      await pairedPage(page);
      await openMockSession(
        page,
        /Resource virtualization and sandbox fixture/,
      );
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      const pane = page.locator(".ctx");
      await pane.getByRole("tab", { name: "Files", exact: true }).click();
      await pane
        .locator(".files-browser__section")
        .filter({ hasText: "Recent" })
        .getByRole("button", { name: /page\.html/ })
        .click();
      await expect(
        pane.getByRole("button", { name: "Download page.html", exact: true }),
      ).toBeEnabled();
      await page.evaluate(() => document.fonts.ready);
      const copiedPaths: string[] = [];
      await page.exposeFunction("captureResourcePath", (path: string) => {
        copiedPaths.push(path);
      });
      await page.evaluate(() => {
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: (path: string) =>
            (
              window as unknown as {
                captureResourcePath: (path: string) => Promise<void>;
              }
            ).captureResourcePath(path),
        });
      });
      for (const [width, height] of [
        [1366, 768],
        [901, 390],
        [390, 844],
        [320, 640],
        [568, 320],
      ]) {
        await page.setViewportSize({ width, height });
        let filesHeaderTop = 0;
        for (const mode of ["Files", "Changes"]) {
          if (mode === "Files") {
            await pane
              .getByRole("tab", { name: "page.html", exact: true })
              .click();
            const changes = pane.getByRole("button", {
              name: "Git changes",
              exact: true,
            });
            if ((await changes.getAttribute("aria-pressed")) === "true")
              await changes.click();
          } else {
            await pane
              .getByRole("tab", { name: "Changes", exact: true })
              .click();
            await expect(pane.locator(".res__list")).toBeVisible();
            await expect(pane.locator(".file-preview__actions")).toHaveCount(0);
            await pane
              .getByRole("button", { name: /page\.html, modified/ })
              .click();
            await expect(
              pane.getByRole("tab", { name: "page.html", exact: true }),
            ).toHaveAttribute("aria-selected", "true");
          }
          const header = pane.locator(".file-preview__actions");
          await expect(header).toBeVisible();
          const headerTop = (await header.boundingBox())!.y;
          if (mode === "Files") filesHeaderTop = headerTop;
          else expect(headerTop).toBeCloseTo(filesHeaderTop, 1);
          const controls = [
            [pane.getByRole("tab", { name: "page.html", exact: true }), "2px"],
            [
              pane.getByRole("button", {
                name: "Close page.html",
                exact: true,
              }),
              "1px",
            ],
            [pane.locator(".file-path-action"), "2px"],
            [
              pane.getByRole("button", { name: "Git changes", exact: true }),
              "2px",
            ],
          ] as const;
          for (const [control, outlineWidth] of controls) {
            await page.keyboard.press("Tab");
            await control.focus();
            await expect(control).toBeFocused();
            await expect(control).toHaveCSS("outline-style", "solid");
            await expect(control).toHaveCSS("outline-width", outlineWidth);
            await expect
              .poll(() => control.evaluate(focusRingClipping))
              .toBeLessThanOrEqual(0.5);
            expect((await header.boundingBox())!.y).toBeCloseTo(headerTop, 1);
          }
          if (width === 320) {
            const copy = pane.locator(".file-path-action");
            const path = (await copy.getAttribute("aria-label"))!.slice(
              "Copy path ".length,
            );
            await copy.press("Enter");
            await expect.poll(() => copiedPaths.at(-1)).toBe(path);
            await expect(copy).toHaveAccessibleName("Path copied");
            expect(await copy.evaluate(focusRingClipping)).toBeLessThanOrEqual(
              0.5,
            );
            expect((await header.boundingBox())!.y).toBeCloseTo(headerTop, 1);
          }
        }
      }
      await pane.getByRole("tab", { name: "Files", exact: true }).click();
      await expect(pane.locator(".files-browser")).toBeVisible();
      await expect(pane.locator(".file-preview__actions")).toHaveCount(0);
    });

    test("centers diff recovery with its status and keeps retry reachable", async ({
      page,
    }) => {
      await pairedPage(page);
      await openMockSession(
        page,
        /Resource virtualization and sandbox fixture/,
      );
      let fail = true;
      await page.route("**/api/git/diff", async (route) => {
        const response = await route.fetch();
        if (fail) {
          await route.fulfill({
            response,
            status: 503,
            json: { error: "Repository temporarily unavailable. Try again." },
          });
        } else await route.fulfill({ response });
      });
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      const pane = page.locator(".ctx");
      await pane.getByRole("tab", { name: "Changes", exact: true }).click();
      await pane.getByRole("button", { name: /page\.html, modified/ }).click();
      const state = pane.locator(".res__state");
      const retry = state.getByRole("button", { name: "Retry", exact: true });
      await expect(state).toContainText("Source unavailable");
      for (const [width, height] of [
        [1366, 768],
        [901, 390],
        [390, 844],
        [320, 640],
        [568, 320],
      ]) {
        await page.setViewportSize({ width, height });
        // Let the drawer layout settle before native focus scrolling.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              );
            }),
        );
        await page.keyboard.press("Tab");
        await retry.focus();
        await expect(retry).toBeInViewport({ ratio: 1 });
        const centered = await state.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const button = element
            .querySelector("button")!
            .getBoundingClientRect();
          return Math.abs(
            box.left + box.width / 2 - button.left - button.width / 2,
          );
        });
        expect(centered).toBeLessThanOrEqual(0.5);
        expect(await retry.evaluate(focusRingClipping)).toBeLessThanOrEqual(
          0.5,
        );
      }
      fail = false;
      await retry.press("Enter");
      await expect(pane.locator(".source-diff")).toBeVisible();
      await expect(retry).toHaveCount(0);
    });
  });
}

test("long diff line numbers keep separate aligned columns and sticky gutters", {
  tag: "@cross-browser",
}, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
  await page.route("**/api/git/diff", async (route) => {
    const response = await route.fetch();
    const diff = (await response.json()) as GitDiffResponse;
    if (diff.kind === "text") {
      diff.lines = diff.lines.map((line) => ({
        ...line,
        // Cross 999 → 1000 within one file, including blank add/delete columns.
        oldLine: line.oldLine == null ? line.oldLine : line.oldLine + 998,
        newLine: line.newLine == null ? line.newLine : line.newLine + 998,
      }));
    }
    await route.fulfill({ response, json: diff });
  });
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const pane = page.locator(".ctx");
  await pane.getByRole("tab", { name: "Changes", exact: true }).click();
  await pane.getByRole("button", { name: /page\.html, modified/ }).click();
  const source = pane.locator(".source-diff");
  await expect(source).toContainText("1000");
  for (const width of [1280, 901, 568, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    const geometry = await source
      .locator(".source-diff__line")
      .evaluateAll((rows) =>
        rows.map((row) => ({
          code: row.querySelector("code")!.getBoundingClientRect().left,
          numbers: [...row.querySelectorAll(".source-diff__number")]
            .filter((el) => el.textContent)
            .map((el) => {
              const range = document.createRange();
              range.selectNodeContents(el);
              const glyphs = range.getBoundingClientRect();
              const box = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return {
                leftGap: glyphs.left - box.left - parseFloat(style.paddingLeft),
                rightGap:
                  box.right - glyphs.right - parseFloat(style.paddingRight),
              };
            }),
        })),
      );
    expect(
      Math.max(...geometry.map((row) => row.code)) -
        Math.min(...geometry.map((row) => row.code)),
    ).toBeLessThanOrEqual(0.5);
    for (const row of geometry)
      for (const number of row.numbers) {
        expect(number.leftGap).toBeGreaterThanOrEqual(-0.5);
        expect(number.rightGap).toBeGreaterThanOrEqual(-0.5);
      }
    const gutter = source.locator(".source-diff__gutter").first();
    const left = (await gutter.boundingBox())!.x;
    await source.evaluate((el) => {
      el.scrollLeft = 160;
    });
    expect((await gutter.boundingBox())!.x).toBeCloseTo(left, 1);
  }
});

test("change navigation preserves addition and deletion colors", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
  await page.route("**/api/git/diff", async (route) => {
    const response = await route.fetch();
    const diff = (await response.json()) as GitDiffResponse;
    if (diff.kind === "text") {
      diff.lines = [
        { kind: "delete", text: "-old first", oldLine: 1, newLine: null },
        { kind: "add", text: "+new first", oldLine: null, newLine: 1 },
        { kind: "context", text: " unchanged", oldLine: 2, newLine: 2 },
        { kind: "delete", text: "-old second", oldLine: 3, newLine: null },
        { kind: "add", text: "+new second", oldLine: null, newLine: 3 },
      ];
      diff.additions = 2;
      diff.deletions = 2;
      delete diff.source;
    }
    await route.fulfill({ response, json: diff });
  });
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const pane = page.locator(".ctx");
  await pane.getByRole("tab", { name: "Changes", exact: true }).click();
  await pane.getByRole("button", { name: /page\.html, modified/ }).click();

  const lines = pane.locator(
    ".source-diff__line--add, .source-diff__line--delete",
  );
  await expect(lines).toHaveCount(4);
  const backgrounds = () =>
    lines.evaluateAll((rows) =>
      rows.map((row) => getComputedStyle(row).backgroundColor),
    );
  const original = await backgrounds();
  expect(original[0]).not.toBe(original[1]);
  await expect(pane.getByLabel("Change position")).toHaveText("1 / 2");
  await expect(
    pane.getByRole("button", { name: "Previous change", exact: true }),
  ).toBeDisabled();

  await pane.getByRole("button", { name: "Next change", exact: true }).click();
  await expect(pane.getByLabel("Change position")).toHaveText("2 / 2");
  await expect(
    pane.getByRole("button", { name: "Next change", exact: true }),
  ).toBeDisabled();
  const active = pane.locator(".source-diff__line--active");
  await expect(active).toHaveCount(2);
  expect(await backgrounds()).toEqual(original);
  expect(
    await active.first().evaluate((row) => getComputedStyle(row).boxShadow),
  ).not.toBe("none");
  await pane
    .getByRole("button", { name: "Previous change", exact: true })
    .click();
  await expect(pane.getByLabel("Change position")).toHaveText("1 / 2");
  expect(await backgrounds()).toEqual(original);
});

for (const touch of [false, true]) {
  test.describe(`${touch ? "touch" : "desktop"} source navigation`, () => {
    test.use({
      viewport: touch
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      hasTouch: touch,
    });
    test("refreshes visible source in place and retains reading after first-change landing", async ({
      page,
    }) => {
      await page.clock.install();
      await pairedPage(page);
      let latest = false;
      let diffReads = 0;
      let gate: Promise<void> | null = null;
      await page.route("**/api/git/diff", async (route) => {
        diffReads += 1;
        const response = await route.fetch();
        const diff = (await response.json()) as GitDiffResponse;
        if (latest && diff.kind === "text") {
          if (gate) await gate;
          diff.lines = diff.lines.map((line) =>
            line.kind === "add"
              ? { ...line, text: "+LATEST_VISIBLE_SOURCE" }
              : line,
          );
          delete diff.source;
        }
        await route.fulfill({ response, json: diff });
      });
      const navigation = page.getByRole("button", {
        name: /^(Toggle|Expand|Collapse) navigation$/,
        exact: true,
      });
      if ((await navigation.getAttribute("aria-expanded")) === "false")
        await navigation.click();
      await openMockSession(
        page,
        /Resource virtualization and sandbox fixture/,
      );
      const toggle = page.getByRole("button", {
        name: "Toggle resources panel",
      });
      if ((await toggle.getAttribute("aria-expanded")) === "false")
        await toggle.click();
      const pane = page.locator(".ctx");
      await pane.getByRole("tab", { name: "Files", exact: true }).click();
      const tree = pane.getByRole("region", { name: "Workspace file tree" });
      const file = tree.locator('[data-workspace-path="README.md"]');
      const folder = tree.getByRole("button", { name: "src", exact: true });
      await expect(file).toBeVisible();
      await expect(folder).toBeVisible();
      const nameX = (row: typeof file) =>
        row
          .locator(".workspace-tree__name")
          .evaluate((node) => node.getBoundingClientRect().x);
      expect(await nameX(file)).toBe(await nameX(folder));

      await pane.getByRole("tab", { name: "Changes", exact: true }).click();
      await pane.getByRole("button", { name: /page\.html, modified/ }).click();
      const source = pane.locator(".source-diff");
      const first = source.locator('[data-change-index="0"]');
      await expect(first).toBeInViewport();
      expect(await source.evaluate((node) => node.scrollTop)).toBeGreaterThan(
        0,
      );

      await source.evaluate((node) => {
        node.scrollTop = 800;
        node.scrollLeft = 50;
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      const position = () =>
        source.evaluate((node) => [node.scrollTop, node.scrollLeft]);
      const saved = await position();
      const oldAddition = await source
        .locator(".source-diff__line--add code")
        .innerText();
      const readsBeforePoll = diffReads;
      latest = true;
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.clock.fastForward(4_001);
      await expect.poll(() => diffReads).toBeGreaterThan(readsBeforePoll);
      await expect(source.locator(".source-diff__line--add code")).toHaveText(
        oldAddition,
      );
      await expect(
        pane.getByText("Loading source", { exact: true }),
      ).toHaveCount(0);
      expect(await position()).toEqual(saved);
      release();
      gate = null;
      await expect(source.locator(".source-diff__line--add code")).toHaveText(
        "LATEST_VISIBLE_SOURCE",
      );
      await expect.poll(position).toEqual(saved);
      const readsBeforeExplicit = diffReads;
      const refreshed = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/git/diff",
      );
      await pane.getByRole("button", { name: "Refresh context pane" }).click();
      await refreshed;
      await expect.poll(position).toEqual(saved);
      expect(diffReads).toBe(readsBeforeExplicit + 1);
      await pane.getByRole("tab", { name: "Files", exact: true }).click();
      await pane.getByRole("tab", { name: "Changes", exact: true }).click();
      await expect(pane.locator(".res__list")).toBeVisible();
      await expect(source).toHaveCount(0);
      await pane.getByRole("tab", { name: "page.html", exact: true }).click();
      await expect.poll(position).toEqual(saved);
      await expect(pane.getByLabel("Change position")).toHaveText("1 / 1");
      await expect(
        pane.getByRole("button", { name: "Next change", exact: true }),
      ).toBeDisabled();
      await expect(pane.locator(".source-diff__line--active")).toHaveCount(2);
      if (touch) {
        await expect(
          pane.getByRole("combobox", { name: "Comparison side" }),
        ).toHaveCount(0);
        const savedBeforeNavigation = await position();
        await pane.getByRole("tab", { name: "Changes", exact: true }).click();
        await expect(pane.locator(".res__list")).toBeVisible();
        await expect(pane.locator(".file-preview__actions")).toHaveCount(0);
        await pane
          .getByRole("button", { name: /page\.html, modified/ })
          .click();
        await expect(
          pane.getByRole("tab", { name: "page.html", exact: true }),
        ).toHaveCount(1);
        await expect.poll(position).toEqual(savedBeforeNavigation);
        await expect(pane).toHaveRole("dialog");
        // A file tab adds no second drawer level to browser history.
        await page.goBack();
        await expect(pane).toBeHidden();
      }
    });
  });
}

test("Files and Changes open one file tab with explicit body and diff views", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const resources = page.getByRole("complementary", { name: "Context panel" });
  await resources
    .locator(".files-browser__section")
    .filter({ hasText: "Recent" })
    .getByRole("button", { name: /page\.html/ })
    .click();
  const frame = page.frameLocator("iframe[title='Preview page.html']");
  await expect(
    resources.getByRole("tab", { name: "page.html", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(resources.locator(".res__index")).toHaveCount(0);
  await expect(resources.locator(".files-browser")).toHaveCount(0);

  await resources.getByRole("tab", { name: "Changes", exact: true }).click();
  await expect(resources.locator(".res__index-title")).toHaveText(
    "mock/analysis",
  );
  await expect(resources.locator(".res__index-summary")).toHaveText("1 change");
  await expect(resources.locator(".res__index-summary")).toHaveAttribute(
    "title",
    "1 change",
  );
  await expect(resources.locator(".res__index-title")).toHaveAttribute(
    "title",
    "mock/analysis",
  );
  await expect(resources.locator(".file-preview__actions")).toHaveCount(0);
  await expect(resources.locator(".source-diff")).toHaveCount(0);
  await resources.getByRole("button", { name: /page\.html, modified/ }).click();
  const fileTab = resources.getByRole("tab", {
    name: "page.html",
    exact: true,
  });
  const changes = resources.getByRole("button", {
    name: "Git changes",
    exact: true,
  });
  await expect(fileTab).toHaveCount(1);
  await expect(fileTab).toHaveAttribute("aria-selected", "true");
  await expect(changes).toHaveAttribute("aria-pressed", "true");
  await expect(resources.locator(".changes__additions")).toHaveText("+1");
  await expect(resources.locator(".changes__deletions")).toHaveText("−1");
  await expect(
    resources.getByRole("region", { name: /Source changes for .*page\.html/ }),
  ).toBeVisible();
  await expect(resources.getByLabel("Change position")).toHaveText("1 / 1");
  await changes.click();
  await expect(changes).toHaveAttribute("aria-pressed", "false");
  await expect(frame.locator("h1")).toHaveText(
    "Quiet systems, legible signals.",
  );
  await expect(resources.getByLabel("Change position")).toHaveCount(0);
  await changes.click();
  await expect(resources.locator(".source-diff")).toBeVisible();
  await resources.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(resources.locator(".files-browser")).toBeVisible();
  await resources
    .locator(".files-browser__section")
    .filter({ hasText: "Recent" })
    .getByRole("button", { name: /page\.html/ })
    .click();
  await expect(fileTab).toHaveCount(1);
  await expect(changes).toHaveAttribute("aria-pressed", "false");
  await expect(frame.locator("h1")).toHaveText(
    "Quiet systems, legible signals.",
  );
  await resources.getByRole("tab", { name: "Changes", exact: true }).click();
  await expect(resources.locator(".res__list")).toBeVisible();
  await expect(resources.locator(".file-preview__actions")).toHaveCount(0);
  await fileTab.click();
  await expect(frame.locator("h1")).toHaveText(
    "Quiet systems, legible signals.",
  );
});

for (const hasTouch of [false, true]) {
  test(`Files and Changes retain their own navigation and reachable actions · ${hasTouch ? "touch" : "mouse"}`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      hasTouch,
      deviceScaleFactor: hasTouch ? 2 : 1,
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    try {
      await pairedPage(page);
      await openMockSession(
        page,
        /Resource virtualization and sandbox fixture/,
      );
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      const pane = page.locator('[aria-label="Context panel"]');
      await pane
        .locator(".files-browser__section")
        .filter({ hasText: "Recent" })
        .getByRole("button", { name: /page\.html/ })
        .click();
      await page.evaluate(
        (theme) => {
          document.documentElement.dataset.theme = theme;
        },
        hasTouch ? "dark" : "light",
      );
      const header = pane.locator(".res__body--changes > .res__index-header");
      for (const viewport of [
        { width: 1280, height: 900 },
        { width: 901, height: 700 },
        { width: 820, height: 900 },
        { width: 390, height: 844 },
        { width: 320, height: 640 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(pane).toHaveRole(
          viewport.width <= 900 ? "dialog" : "complementary",
        );
        await pane.getByRole("tab", { name: "page.html", exact: true }).click();
        await expect(pane.locator(".res__index")).toHaveCount(0);
        await expect(pane.locator(".files-browser")).toHaveCount(0);
        const filesDetail = (await pane
          .locator(".file-preview__actions")
          .boundingBox())!;
        const content = (await pane
          .getByRole("tabpanel", { name: "File", exact: true })
          .boundingBox())!;
        expect(filesDetail.y).toBeCloseTo(content.y + 8, 1);
        await pane.getByRole("tab", { name: "Changes", exact: true }).click();
        await expect(header).toBeVisible();
        await expect(pane.locator(".file-preview__actions")).toHaveCount(0);
        const list = pane.locator(".res__list");
        await expect(list).toBeVisible();
        const changesContent = (await pane
          .getByRole("tabpanel", { name: "Changes", exact: true })
          .boundingBox())!;
        const listBox = (await list.boundingBox())!;
        const headerBox = (await header.boundingBox())!;
        expect(headerBox.y).toBeCloseTo(changesContent.y, 1);
        expect(listBox.y).toBeCloseTo(headerBox.y + headerBox.height, 1);
        expect(listBox.y + listBox.height).toBeCloseTo(
          changesContent.y + changesContent.height,
          1,
        );
        await pane
          .getByRole("button", { name: /page\.html, modified/ })
          .click();
        await expect(
          pane.getByRole("tab", { name: "page.html", exact: true }),
        ).toHaveCount(1);
        const git = pane.getByRole("button", {
          name: "Git changes",
          exact: true,
        });
        await expect(git).toHaveAttribute("aria-pressed", "true");
        expect(
          (await pane.locator(".file-preview__actions").boundingBox())!.y,
        ).toBeCloseTo(filesDetail.y, 1);
        await page.keyboard.press("Tab");
        await git.focus();
        await expect(git).toBeFocused();
        await expect(git).toBeInViewport({ ratio: 1 });
        expect(await git.evaluate(focusRingClipping)).toBeLessThanOrEqual(0.5);
        await pane.getByRole("tab", { name: "Files", exact: true }).click();
        await expect(pane.locator(".files-browser")).toBeVisible();
        await expect(pane.locator(".file-preview__actions")).toHaveCount(0);
        const visibility = pane.getByRole("button", {
          name: "Show hidden files",
          exact: true,
        });
        await page.keyboard.press("Tab");
        await visibility.focus();
        await expect(visibility).toBeFocused();
        expect(
          await visibility.evaluate(focusRingClipping),
        ).toBeLessThanOrEqual(0.5);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await pane
        .getByRole("button", { name: "Show hidden files", exact: true })
        .click();
      await expect(
        pane.getByRole("button", { name: "Show hidden files", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(pane.locator(".files-browser")).toBeVisible();
    } finally {
      await context.close();
    }
  });
}
