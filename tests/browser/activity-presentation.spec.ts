import { expect, test } from "@playwright/test";
import { openMockSession, pairedPage } from "./support/navigation";

test("activity dots swap theme colors without layout motion and respect reduced motion", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const dots = page
    .locator(".activity-fold__summary-badge .activity-fold__dots")
    .first();
  await expect(dots).toBeVisible();
  // Lifecycle wiring is covered by the fold unit tests. Isolate CSS here so
  // animation checks do not depend on the mock worker's streaming duration.
  await dots.evaluate((element) =>
    element.classList.add("activity-fold__dots--active"),
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const palette of ["amber", "teal"]) {
    for (const theme of ["light", "dark"]) {
      const result = await dots.evaluate(
        (element, { palette, theme }) => {
          document.documentElement.dataset.palette = palette;
          document.documentElement.dataset.theme = theme;
          const rootStyle = getComputedStyle(document.documentElement);
          const color = (token: string) => {
            const probe = document.createElement("span");
            probe.style.color = rootStyle.getPropertyValue(token).trim();
            return probe.style.color;
          };
          const frames = [100, 1100].map((time) => {
            const colors = Array.from(element.children, (dot) => {
              for (const animation of dot.getAnimations()) {
                animation.pause();
                animation.currentTime = time;
              }
              return getComputedStyle(dot, "::before").backgroundColor;
            });
            const { width, height } = element.getBoundingClientRect();
            return { colors, width, height };
          });
          return {
            frames,
            tool: color("--activity-tool"),
            thinking: color("--activity-think"),
          };
        },
        { palette, theme },
      );
      expect(result.frames[0]!.colors).toEqual([
        result.tool,
        result.thinking,
        result.tool,
      ]);
      expect(result.frames[1]!.colors).toEqual([
        result.thinking,
        result.tool,
        result.thinking,
      ]);
      expect(result.frames[0]!.width).toBe(result.frames[1]!.width);
      expect(result.frames[0]!.height).toBe(result.frames[1]!.height);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".transcript").hover();
  await page.mouse.wheel(0, -5000);
  await dots.scrollIntoViewIfNeeded();
  await expect(dots).toBeInViewport();

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await dots.evaluate((element) =>
      Array.from(
        element.children,
        (dot) => getComputedStyle(dot).animationName,
      ),
    ),
  ).toEqual(["none", "none", "none"]);
});
