import { expect, test } from "@playwright/test";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import { openMockEventSession } from "./support/mock-host";
import { textBaseline } from "./support/text-baseline";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });

test("the sans session title and mono workspace/status have balanced visible centers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const send = await openMockEventSession(
    page,
    "frontend",
    emptyToolPresentationConfiguration(),
  );
  send({
    type: "extension_ui_request",
    id: "layout-status",
    method: "setStatus",
    responseRequired: false,
    extensionStatuses: { mc: "mc: 133.4K (65%) · idle" },
  });
  await expect(page.locator(".topbar__extension-text")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const inkCenter = async (selector: string) => {
    const label = page.locator(selector);
    const baseline = await label.evaluate(textBaseline);
    return (
      baseline +
      (await label.evaluate((el) => {
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = getComputedStyle(el).font;
        const ink = ctx.measureText(el.textContent ?? "");
        return (ink.actualBoundingBoxDescent - ink.actualBoundingBoxAscent) / 2;
      }))
    );
  };
  const title = await inkCenter(".topbar__title-button > span");
  for (const selector of [
    ".topbar__project-label",
    ".topbar__extension-text",
  ]) {
    expect(Math.abs((await inkCenter(selector)) - title)).toBeLessThan(1);
  }
  const before = (await page.locator(".topbar__heading").boundingBox())!;
  await page
    .getByRole("button", { name: "Session actions: frontend", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Rename session", exact: true })
    .click();
  const editor = page.getByRole("textbox", {
    name: "Session name",
    exact: true,
  });
  await expect(editor).toBeVisible();
  const box = (await editor.boundingBox())!;
  expect(
    Math.abs(box.y + box.height / 2 - before.y - before.height / 2),
  ).toBeLessThanOrEqual(1);
  await editor.press("Escape");
  await expect(
    page.getByRole("button", {
      name: "Session actions: frontend",
      exact: true,
    }),
  ).toBeFocused();
});
