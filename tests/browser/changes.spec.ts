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
      await pane.getByRole("button", { name: "Files", exact: true }).click();
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
          await pane.getByRole("button", { name: mode, exact: true }).click();
          const header = pane.locator(".file-detail-header");
          await expect(header).toBeVisible();
          const headerTop = (await header.boundingBox())!.y;
          if (mode === "Files") filesHeaderTop = headerTop;
          else expect(headerTop).toBeCloseTo(filesHeaderTop, 1);
          const controls =
            mode === "Files"
              ? [
                  pane.getByRole("button", {
                    name: /Back to file browser for/,
                  }),
                  pane.getByRole("button", {
                    name: "Show hidden files",
                    exact: true,
                  }),
                  pane.locator(".file-path-action"),
                ]
              : [pane.locator(".file-path-action")];
          for (const control of controls) {
            await page.keyboard.press("Tab");
            await control.focus();
            await expect(control).toBeFocused();
            await expect(control).toHaveCSS("outline-style", "solid");
            await expect(control).toHaveCSS("outline-width", "2px");
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
      await pane.getByRole("button", { name: "Files", exact: true }).click();
      await pane
        .getByRole("button", { name: /Back to file browser for/ })
        .click();
      await expect(pane.locator(".files-browser")).toBeVisible();
      await expect(pane.locator(".file-detail-header")).toHaveCount(0);
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
      await pane.getByRole("button", { name: "Changes", exact: true }).click();
      await pane
        .getByRole("button", { name: /page\.html, unstaged modified/ })
        .click();
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
        // Let the ResizeObserver split budget commit before native focus scrolling.
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
  await pane.getByRole("button", { name: "Changes", exact: true }).click();
  await pane
    .getByRole("button", { name: /page\.html, unstaged modified/ })
    .click();
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
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const pane = page.locator(".ctx");
  await pane.getByRole("button", { name: "Changes", exact: true }).click();
  await pane
    .getByRole("button", { name: /page\.html, unstaged modified/ })
    .click();

  const lines = pane.locator(
    ".source-diff__line--add, .source-diff__line--delete",
  );
  await expect(lines).toHaveCount(2);
  const backgrounds = () =>
    lines.evaluateAll((rows) =>
      rows.map((row) => getComputedStyle(row).backgroundColor),
    );
  const unselected = await backgrounds();
  expect(unselected[0]).not.toBe(unselected[1]);

  await pane.getByRole("button", { name: "Next change", exact: true }).click();
  await expect(pane.locator(".source-diff__line--active")).toHaveCount(2);
  expect(await backgrounds()).toEqual(unselected);
  expect(
    await lines.first().evaluate((row) => getComputedStyle(row).boxShadow),
  ).not.toBe("none");
});

for (const touch of [false, true]) {
  test.describe(`${touch ? "touch" : "desktop"} source navigation`, () => {
    test.use({
      viewport: touch
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      hasTouch: touch,
    });
    test("aligns tree siblings and retains diff reading after first-change landing", async ({
      page,
    }) => {
      await pairedPage(page);
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
      await pane.getByRole("button", { name: "Files", exact: true }).click();
      const tree = pane.getByRole("region", { name: "Workspace file tree" });
      const file = tree.getByTitle("README.md", { exact: true });
      const folder = tree.getByTitle("src", { exact: true });
      await expect(file).toBeVisible();
      const nameX = (row: typeof file) =>
        row
          .locator(".workspace-tree__name")
          .evaluate((node) => node.getBoundingClientRect().x);
      expect(await nameX(file)).toBe(await nameX(folder));

      await pane.getByRole("button", { name: "Changes", exact: true }).click();
      await pane
        .getByRole("button", { name: /page\.html, unstaged modified/ })
        .click();
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
      const refreshed = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/git/diff",
      );
      await pane.getByRole("button", { name: "Refresh context pane" }).click();
      await refreshed;
      await expect.poll(position).toEqual(saved);
      await pane.getByRole("button", { name: "Files", exact: true }).click();
      await pane.getByRole("button", { name: "Changes", exact: true }).click();
      await expect.poll(position).toEqual(saved);
      await pane
        .getByRole("button", { name: "Next change", exact: true })
        .click();
      await expect(first).toBeInViewport();
      await expect(pane.locator(".source-diff__line--active")).toHaveCount(2);
    });
  });
}

test("Files and Changes share the index boundary and preserve the selected file reader", async ({
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
  const workspaceIndex = resources.locator(".res__index");
  const workspaceIndexHeight = () =>
    workspaceIndex.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
  const stableIndexHeight = await workspaceIndexHeight();
  expect(stableIndexHeight).toBeGreaterThan(200);

  await resources.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(resources.locator(".res__index-title")).toHaveText(
    "mock/analysis",
  );
  await expect(resources.locator(".res__index-summary")).toHaveText(
    "1 working",
  );
  await expect(resources.locator(".res__index-summary")).toHaveAttribute(
    "title",
    "1 working",
  );
  await expect(resources.locator(".res__index-title")).toHaveAttribute(
    "title",
    "mock/analysis",
  );
  await expect(resources.locator(".changes__additions")).toHaveText("+1");
  await expect(resources.locator(".changes__deletions")).toHaveText("−1");
  await expect(
    resources.getByRole("region", {
      name: /Source changes for .*page\.html/,
    }),
  ).toBeVisible();
  await resources.getByRole("button", { name: "Next change" }).click();
  await expect(resources.locator(".source-diff__line--active")).toHaveCount(2);
  expect(await workspaceIndexHeight()).toBeCloseTo(stableIndexHeight, 1);
  await resources.getByRole("button", { name: "Files", exact: true }).click();
  await expect(frame.locator("h1")).toHaveText(
    "Quiet systems, legible signals.",
  );
});

for (const hasTouch of [false, true]) {
  test(`resource index headers retain their shared contour and action alignment · ${hasTouch ? "touch" : "mouse"}`, async ({
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
      const header = pane.locator(".res__index > .res__index-header");
      const geometry = () =>
        pane.evaluate((element) => {
          const rect = (selector: string) => {
            const value = element
              .querySelector(selector)!
              .getBoundingClientRect();
            return {
              top: value.top,
              bottom: value.bottom,
              height: value.height,
            };
          };
          return {
            header: rect(".res__index > .res__index-header"),
            index: rect(".res__index"),
            detail: rect(".file-detail-header"),
          };
        });
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
        await expect(header).toHaveCSS("border-bottom-width", "1px");
        await expect(header).toHaveCSS("border-bottom-style", "solid");
        const files = await geometry();
        expect(files.header.height).toBe(30);
        const actions = await header.evaluate((element) => {
          const center = (selector: string) => {
            const rect = element
              .querySelector(selector)!
              .getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          };
          return {
            back: center(".res__index-header--back > svg"),
            visibility: center(".icon-button > svg"),
          };
        });
        expect(
          Math.abs(actions.back.y - actions.visibility.y),
        ).toBeLessThanOrEqual(0.5);
        const visibility = pane.getByRole("button", {
          name: "Show hidden files",
          exact: true,
        });
        const back = pane.getByRole("button", {
          name: /Back to file browser for/,
        });
        await page.keyboard.press("Tab");
        await back.focus();
        await expect(back).toBeFocused();
        await expect(back).toHaveCSS("outline-offset", "-2px");
        await visibility.focus();
        await expect(visibility).toHaveCSS("outline-offset", "-2px");
        await pane
          .getByRole("button", { name: "Changes", exact: true })
          .click();
        await expect(header).toHaveCSS("border-bottom-width", "1px");
        const changes = await geometry();
        for (const area of ["header", "index", "detail"] as const) {
          for (const edge of ["top", "bottom", "height"] as const) {
            expect(
              Math.abs(changes[area][edge] - files[area][edge]),
              `${area} ${edge} at ${viewport.width}`,
            ).toBeLessThanOrEqual(0.5);
          }
        }
        await pane.getByRole("button", { name: "Files", exact: true }).click();
      }
      await pane
        .getByRole("button", { name: "Show hidden files", exact: true })
        .click();
      await expect(
        pane.getByRole("button", { name: "Show hidden files", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await pane
        .getByRole("button", { name: /Back to file browser for/ })
        .click();
      await expect(pane.locator(".files-browser")).toBeVisible();
    } finally {
      await context.close();
    }
  });
}
