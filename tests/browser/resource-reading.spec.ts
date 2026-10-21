import { expect, test } from "@playwright/test";
import { customMessageConfiguration } from "../web/fixtures/custom-message-presentation";
import { hostRequest } from "./support/host-request";
import { openMockEventSession, routeMockSnapshots } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";
import { firstTextBaseline } from "./support/text-baseline";
import { textOverflowsInlineBounds } from "./support/text-bounds";

for (const mode of ["Files", "Changes"] as const) {
  test(`${mode} preview errors scroll inside the reader and keep Retry reachable in short windows`, {
    tag: "@cross-browser",
  }, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairedPage(page);
    await openMockSession(page, /Resource virtualization and sandbox fixture/);
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    const pane = page.locator(".ctx");
    await pane.getByRole("button", { name: mode, exact: true }).click();
    let unavailable = true;
    await page.route(
      mode === "Files" ? "**/api/resources/resolve" : "**/api/git/diff",
      (route) =>
        unavailable
          ? route.fulfill({
              status: 503,
              json: {
                error: "This file is temporarily unavailable. Try again.",
              },
            })
          : route.continue(),
    );
    if (mode === "Files") {
      await pane
        .getByRole("searchbox", { name: "Search workspace files" })
        .fill("file-previews/document.md");
      await pane
        .locator(
          '[data-workspace-path="tests/browser/fixtures/file-previews/document.md"]',
        )
        .click();
    } else {
      await pane
        .getByRole("button", { name: /page\.html, unstaged modified/ })
        .click();
    }
    const frame = pane.locator(
      mode === "Files" ? ".file-preview__content" : ".changes__content",
    );
    const state = frame.locator(":scope > .res__state");
    const retry = state.getByRole("button", { name: "Retry", exact: true });
    await expect(state).toContainText(
      mode === "Files" ? "Preview unavailable" : "Source unavailable",
    );
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 901, height: 390 },
      { width: 568, height: 320 },
      { width: 320, height: 640 },
    ]) {
      await page.setViewportSize(viewport);
      await expect
        .poll(() =>
          frame.evaluate((el) => {
            const bounds = el.getBoundingClientRect();
            const parent = el.parentElement!.getBoundingClientRect();
            return (
              bounds.top >= parent.top - 0.5 &&
              bounds.bottom <= parent.bottom + 0.5
            );
          }),
        )
        .toBe(true);
      await expect(frame).toHaveCSS("overflow-y", "auto");
      await expect
        .poll(async () => {
          // The split height settles after the viewport and drawer transition.
          await frame.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          return retry.evaluate((button) => {
            const bounds = button.getBoundingClientRect();
            const parent = button
              .closest(".file-preview__content, .changes__content")!
              .getBoundingClientRect();
            const visible = document.elementFromPoint(
              bounds.x + bounds.width / 2,
              bounds.y + bounds.height / 2,
            );
            return (
              bounds.top >= parent.top - 0.5 &&
              bounds.bottom <= parent.bottom + 0.5 &&
              !!visible &&
              button.contains(visible)
            );
          });
        })
        .toBe(true);
    }
    await page.setViewportSize({ width: 568, height: 320 });
    unavailable = false;
    await retry.click();
    await expect(state).toHaveCount(0);
    await expect(frame).toHaveCSS("overflow-y", "hidden");
    if (mode === "Files") {
      await expect(pane.locator(".file-detail-header")).toContainText(
        "document.md",
      );
      await expect(
        pane.getByRole("heading", { name: "Observation log · Station 07" }),
      ).toBeVisible();
    } else {
      await expect(pane.locator(".source-diff")).toBeVisible();
    }
  });
}

test("conversation image-reference marks follow the first caption line across reading surfaces", async ({
  page,
}) => {
  const send = await openMockEventSession(
    page,
    "Image references",
    customMessageConfiguration,
    {
      activityFoldVisibility: "expanded",
      thinkingVisibility: "expanded",
    },
  );
  const captions = [
    "chart",
    "Temperature-dependent calibration repeatability and instrument stability assessment",
    "温度相关仪器校准与长时间重复性误差分析结果以及测量不确定度评估",
  ];
  const text = captions
    .map((caption) => "![" + caption + "](figures/calibration.png)")
    .join("\n\n");
  send(
    {
      type: "message_end",
      message: {
        role: "user",
        content: text,
        __inspireMessageId: "references-user",
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: text },
          { type: "text", text },
        ],
        __inspireMessageId: "references-assistant",
      },
    },
  );
  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 1200 });
    for (const surface of [
      ".rich-text--user",
      ".rich-text--assistant",
      ".rich-text--thinking",
    ]) {
      const refs = page.locator(surface).last().locator(".file-ref--image");
      await expect(refs).toHaveCount(captions.length);
      await page.evaluate(() => document.fonts.ready);
      for (const ref of await refs.all()) {
        // Relative measurements remain stable if virtualized reading scrolls.
        const mark = await ref
          .locator("span")
          .nth(0)
          .evaluate(firstTextBaseline, ".file-ref--image");
        const caption = await ref
          .locator("span")
          .nth(1)
          .evaluate(firstTextBaseline, ".file-ref--image");
        expect(mark).not.toBeNull();
        expect(caption).not.toBeNull();
        expect(Math.abs(mark! - caption!)).toBeLessThanOrEqual(0.5);
        expect(
          await ref
            .locator("span")
            .nth(1)
            .evaluate((el) => {
              const range = document.createRange();
              range.selectNodeContents(el);
              const left = el.getBoundingClientRect().left;
              // Chromium gives wrapped trailing spaces their own rect.
              const starts = new Map<number, number>();
              for (const rect of range.getClientRects()) {
                if (rect.width > 0)
                  starts.set(
                    rect.top,
                    Math.min(starts.get(rect.top) ?? Infinity, rect.left),
                  );
              }
              return [...starts.values()].every(
                (start) => Math.abs(start - left) <= 0.5,
              );
            }),
        ).toBe(true);
        await expect(ref).toHaveAttribute(
          "data-file-path",
          "figures/calibration.png",
        );
        expect(
          await ref.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
      }
    }
  }
});

test("file path toolbars distinguish the reader from browser chrome across palettes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
  const host = hostRequest(page);
  const before = await (await host.get("/api/preferences")).json();
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const pane = page.locator(".ctx");
  await pane
    .getByRole("searchbox", { name: "Search workspace files" })
    .fill("document.md");
  await pane
    .getByRole("button", {
      name: /document\.md.*tests\/browser\/fixtures\/file-previews/,
    })
    .click();
  await expect(pane.locator(".rich-text p").first()).toBeVisible();
  try {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await settings
      .getByRole("button", { name: "Display", exact: true })
      .click();
    for (const theme of ["Light", "Dark"]) {
      await settings
        .getByRole("group", { name: "Theme", exact: true })
        .getByRole("button", { name: theme, exact: true })
        .click();
      for (const palette of [
        "Wisteria",
        "Hydrangea",
        "Lycoris",
        "Chimonanthus",
        "Jade",
        "Amber",
      ]) {
        await settings
          .getByRole("group", { name: "Color palette", exact: true })
          .getByRole("button", { name: palette, exact: true })
          .click();
        const surfaces = await pane.evaluate((el) => {
          const index = el.querySelector(".res__index-header")!;
          const detail = el.querySelector(".file-detail-header")!;
          const probe = document.createElement("span");
          probe.style.backgroundColor = "var(--bg-surface)";
          detail.append(probe);
          const result = {
            index: getComputedStyle(index).backgroundColor,
            detail: getComputedStyle(detail).backgroundColor,
            expected: getComputedStyle(probe).backgroundColor,
          };
          probe.remove();
          return result;
        });
        expect(surfaces.detail, theme + " " + palette).toBe(surfaces.expected);
        expect(surfaces.detail, theme + " " + palette).not.toBe(surfaces.index);
      }
    }
    await settings.press("Escape");
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(pane.locator(".file-detail-header")).toHaveCSS(
        "height",
        "34px",
      );
      expect(
        await pane.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
    }
  } finally {
    await host.patch("/api/preferences", {
      data: { theme: before.theme, palette: before.palette },
    });
  }
});

test("Markdown and notebook prose follow reading size without scaling resource chrome", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
  const host = hostRequest(page);
  const before = await (await host.get("/api/preferences")).json();
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const pane = page.locator(".ctx");
  const chromeSize = await pane
    .getByRole("button", { name: "Files", exact: true })
    .evaluate((el) => getComputedStyle(el).fontSize);
  try {
    for (const file of ["document.md", "notebook.ipynb"]) {
      const back = pane.getByRole("button", {
        name: /Back to file browser for/,
      });
      if (await back.isVisible()) await back.click();
      await pane
        .getByRole("searchbox", { name: "Search workspace files" })
        .fill(file);
      await pane
        .getByRole("button", {
          name: new RegExp(
            file.replace(".", "\\.") + ".*tests/browser/fixtures/file-previews",
          ),
        })
        .click();
      const paragraph = pane.locator(".rich-text p").first();
      await expect(paragraph).toBeVisible();
      for (const [contentTextSize, size] of [
        ["compact", "14px"],
        ["comfortable", "15.5px"],
        ["large", "17px"],
      ]) {
        await page
          .getByRole("button", { name: "Settings", exact: true })
          .click();
        const settings = page.getByRole("dialog", {
          name: "Settings",
          exact: true,
        });
        await settings
          .getByRole("button", { name: "Display", exact: true })
          .click();
        await settings
          .getByRole("group", { name: "Content text size", exact: true })
          .getByRole("button")
          .nth(["compact", "comfortable", "large"].indexOf(contentTextSize!))
          .click();
        await expect(page.locator("html")).toHaveAttribute(
          "data-content-text-size",
          contentTextSize!,
        );
        await settings.press("Escape");
        await expect(paragraph).toHaveCSS("font-size", size!);
        await expect(
          pane.getByRole("button", { name: "Files", exact: true }),
        ).toHaveCSS("font-size", chromeSize);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await pane.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  } finally {
    await host.patch("/api/preferences", {
      data: { contentTextSize: before.contentTextSize },
    });
  }
});

for (const theme of ["light", "dark"] as const) {
  for (const operation of ["download", "interaction"] as const) {
    test(`long ${operation} errors wrap within the ${theme} file reader without losing the preview`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await routeMockSnapshots(page, {
        bootstrap(body) {
          body.preferences.theme = theme;
        },
      });
      await pairedPage(page);
      await openMockSession(
        page,
        /Resource virtualization and sandbox fixture/,
      );
      const host = hostRequest(page);
      const authority = (await host.get("/api/preferences")).headers()[
        "x-inspire-authority"
      ];
      const message =
        "EACCES: permission denied, open '/workspace/results/TemperatureDependentReferenceSpectrometerCalibrationRepeatabilityAndMeasurementUncertaintyDecompositionAnalysis.json'";
      await page.route(
        `**/api/resources/*/${operation === "download" ? "download-ticket" : "interactive"}`,
        (route) =>
          route.fulfill({
            status: 403,
            headers: { "X-Inspire-Authority": authority },
            json: { error: message },
          }),
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      const pane = page.locator(".ctx");
      const file =
        operation === "download" ? "document.md" : "interactive.html";
      await pane
        .getByRole("searchbox", { name: "Search workspace files" })
        .fill(file);
      await pane
        .getByRole("button", {
          name: new RegExp(
            `${file.replaceAll(".", "\\.")}.*tests/browser/fixtures/file-previews`,
          ),
        })
        .click();
      const content = pane.locator(
        operation === "download" ? ".rich-text" : "iframe",
      );
      await expect(content).toBeVisible();
      for (const width of [1280, 820, 390, 320]) {
        for (const height of [900, 420]) {
          await page.setViewportSize({ width, height });
          await pane
            .getByRole("button", {
              name:
                operation === "download"
                  ? `Download ${file}`
                  : "Enable interaction",
              exact: true,
            })
            .click();
          const notice = pane.locator(".file-preview__notice");
          await expect(notice).toHaveText(message);
          await page.evaluate(() => document.fonts.ready);
          await expect
            .poll(() => notice.evaluate(textOverflowsInlineBounds))
            .toBe(false);
          await expect
            .poll(() =>
              notice.evaluate((element) => {
                const frame = element.getBoundingClientRect();
                const parent = element.parentElement!.getBoundingClientRect();
                const preview =
                  element.nextElementSibling!.getBoundingClientRect();
                return (
                  frame.top >= parent.top &&
                  frame.bottom <= parent.bottom &&
                  preview.height > 0 &&
                  preview.top >= frame.bottom
                );
              }),
            )
            .toBe(true);
          await expect(content).toBeVisible();
        }
      }
    });
  }
}
