import { expect, test } from "@playwright/test";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import { activityReadingMessages } from "../web/fixtures/activity-reading";
import { openMockEventSession } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";

for (const touch of [false, true]) {
  test.describe(touch ? "touch icon controls" : "pointer icon controls", () => {
    test.use({ hasTouch: touch, reducedMotion: "reduce" });
    test("compact actions retain their declared square glyph and center", async ({
      page,
    }) => {
      const emit = await openMockEventSession(
        page,
        "Compact icon geometry",
        emptyToolPresentationConfiguration(),
        {},
      );
      emit(
        ...activityReadingMessages().map((message) => ({
          type: "message_end",
          message,
        })),
      );
      await expect(page.locator(".turn--user")).toHaveCount(1);
      await page
        .getByRole("button", { name: "Expand assistant activity", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Expand Thinking", exact: true })
        .first()
        .click();

      const measure = () =>
        [
          ...document.querySelectorAll<SVGSVGElement>(
            ".icon-button > svg, .icon-button .copy-feedback > svg, .nav__row-action > svg, .transcript-search > button > svg",
          ),
        ]
          .filter(
            (svg) =>
              svg.checkVisibility() &&
              getComputedStyle(svg).opacity !== "0" &&
              svg.getBoundingClientRect().height,
          )
          .map((svg) => {
            const box = svg.getBoundingClientRect(),
              parent = svg.closest("button")!.getBoundingClientRect();
            return {
              label: svg.closest("button")!.getAttribute("aria-label"),
              width: box.width,
              height: box.height,
              declared: Number(svg.getAttribute("width")),
              x: (box.left + box.right - parent.left - parent.right) / 2,
              y: (box.top + box.bottom - parent.top - parent.bottom) / 2,
            };
          });
      const verify = async () => {
        const icons = await page.evaluate(measure);
        expect(icons.length).toBeGreaterThan(8);
        for (const icon of icons) {
          expect(icon.width, icon.label ?? "").toBeCloseTo(icon.declared, 1);
          expect(icon.height, icon.label ?? "").toBeCloseTo(icon.declared, 1);
          expect(Math.abs(icon.x), icon.label ?? "").toBeLessThan(0.6);
          expect(Math.abs(icon.y), icon.label ?? "").toBeLessThan(0.6);
        }
      };
      for (const width of [1440, 820, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        if (width <= 600)
          await page
            .getByRole("button", { name: "Toggle navigation", exact: true })
            .click();
        await verify();
        if (width <= 600)
          await page
            .getByRole("button", { name: "Close navigation", exact: true })
            .click();
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page
        .getByRole("button", { name: "Toggle resources panel", exact: true })
        .click();
      await page.getByRole("tab", { name: "Files", exact: true }).click();
      await expect(
        page.getByRole("searchbox", { name: "Search workspace files" }),
      ).toBeVisible();
      await verify();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(
        page.locator(".settings__section-heading").first(),
      ).toBeVisible();
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .evaluate(async (el) => {
          await Promise.all(
            el.getAnimations().map((animation) => animation.finished),
          );
        });
      await verify();
    });
  });
}

for (const touch of [false, true]) {
  test.describe(`Files visibility alignment (${touch ? "touch DPR 2" : "pointer DPR 1"})`, () => {
    test.use({
      hasTouch: touch,
      deviceScaleFactor: touch ? 2 : 1,
      reducedMotion: "reduce",
    });
    test("keeps visibility centered in Files and retains its state across file tabs", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await pairedPage(page);
      await openMockSession(
        page,
        /Resource virtualization and sandbox fixture/,
      );
      await page
        .getByRole("button", { name: "Toggle resources panel", exact: true })
        .click();
      const pane = page.locator(".ctx");
      await pane.getByRole("tab", { name: "Files", exact: true }).click();
      const toggle = pane.getByRole("button", {
        name: "Show hidden files",
        exact: true,
      });
      const measure = () =>
        toggle.evaluate((button) => {
          const icon = button.querySelector("svg")!.getBoundingClientRect();
          const bounds = button.getBoundingClientRect();
          return {
            x: icon.x + icon.width / 2,
            y: icon.y + icon.height / 2,
            width: icon.width,
            height: icon.height,
            targetWidth: bounds.width,
            targetHeight: bounds.height,
            cx: bounds.x + bounds.width / 2,
            cy: bounds.y + bounds.height / 2,
          };
        });
      for (const [width, height] of [
        [1280, 900],
        [901, 700],
        [568, 320],
        [390, 844],
        [320, 640],
      ]) {
        await page.setViewportSize({ width, height });
        // Crossing into drawer mode animates the whole panel, not its controls.
        await pane.evaluate(async (el) => {
          await Promise.all(
            el.getAnimations().map((animation) => animation.finished),
          );
        });
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        const browse = await measure();
        await pane
          .getByRole("region", { name: "Workspace file tree", exact: true })
          .getByRole("button", { name: "native-shell.log", exact: true })
          .click();
        const download = pane.getByRole("button", {
          name: "Download native-shell.log",
          exact: true,
        });
        await expect(download).toBeVisible();
        await expect(toggle).toHaveCount(0);
        await pane.getByRole("tab", { name: "Files", exact: true }).click();
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        expect(Math.abs((await measure()).x - browse.x)).toBeLessThanOrEqual(
          0.5,
        );
        for (const pressed of [false, true]) {
          if (pressed) await toggle.click();
          await expect(toggle).toHaveAttribute("aria-pressed", String(pressed));
          const current = await measure();
          expect(Math.abs(current.x - browse.x)).toBeLessThanOrEqual(0.5);
          expect([current.width, current.height]).toEqual([14, 14]);
          if (width > 900)
            expect([current.targetWidth, current.targetHeight]).toEqual([
              28, 28,
            ]);
          expect(Math.abs(current.x - current.cx)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(current.y - current.cy)).toBeLessThanOrEqual(0.5);
          await pane
            .getByRole("tab", { name: "native-shell.log", exact: true })
            .click();
          await expect(download).toBeVisible();
          await expect(toggle).toHaveCount(0);
          await pane.getByRole("tab", { name: "Files", exact: true }).click();
          await expect(toggle).toHaveAttribute("aria-pressed", String(pressed));
        }
        await toggle.focus();
        await page.keyboard.press("Space");
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        expect(Math.abs((await measure()).x - browse.x)).toBeLessThanOrEqual(
          0.5,
        );
      }
    });
  });
}
