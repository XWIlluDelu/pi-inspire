import { expect, type Page, test } from "@playwright/test";
import { routeMockSnapshots } from "./support/mock-host";
import {
  openCommandPalette,
  openMockSession,
  pairedPage,
} from "./support/navigation";

const project = `/workspace/${"long-project-segment/".repeat(8)}analysis.jsonl`;
const sessionFile = `${project}/sessions/retained.jsonl`;
const model = "provider/model-with-a-long-deployment-identity";

async function showUsage(page: Page) {
  const palette = await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("usage");
  await palette.getByRole("option", { name: /Session & usage/ }).click();
}

for (const width of [1280, 390, 320]) {
  test.describe(`Usage facts at ${width}px`, () => {
    test.use({
      serviceWorkers: "block",
      viewport: { width, height: 844 },
      hasTouch: true,
    });
    test("keeps session facts readable and stacked receipts scrollable", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await routeMockSnapshots(page, {
        snapshot(snapshot) {
          if (!snapshot.active) return;
          snapshot.active.cwd = project;
          snapshot.active.sessionFile = sessionFile;
          snapshot.active.model = {
            provider: "provider",
            id: "model-with-a-long-deployment-identity",
          };
          snapshot.active.stats = {
            totalMessages: 12,
            tokens: { total: 9_000_000 },
            cost: 1.25,
            contextUsage: {
              tokens: 123_456,
              contextWindow: 1_000_000,
              percent: 12.3,
            },
          };
        },
      });
      await pairedPage(page);
      await openMockSession(page, /Calibration history fixture/);
      // The existing occupancy control now gives pointer and keyboard users a
      // direct way to reach the same local query, without replacing their draft.
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      await input.fill("Keep this draft");
      const meter = page.getByRole("button", {
        name: /^Session & usage, context/,
      });
      await meter.focus();
      await meter.press("Enter");
      const receipt = page.getByRole("region", { name: "Command activity" });
      await expect(receipt).toContainText("$1.25");
      await expect(input).toHaveValue("Keep this draft");
      await expect(receipt).not.toContainText(sessionFile);
      await expect(receipt).not.toContainText(project);
      await expect(receipt).not.toContainText(model);
      await expect(receipt.getByText("Info", { exact: true })).toBeVisible();
      await expect(
        receipt.getByText("/session", { exact: true }),
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      for (const value of ["9,000,000", "$1.25", "123,456 / 1,000,000 (12%)"]) {
        const field = receipt.getByText(value, { exact: true });
        await expect(field).toBeVisible();
        expect(
          await field.evaluate((node) => {
            const style = getComputedStyle(node);
            return (
              node.scrollWidth <= node.clientWidth + 1 &&
              style.textOverflow !== "ellipsis"
            );
          }),
        ).toBe(true);
      }
      expect(
        await receipt.evaluate(
          (node) => node.scrollWidth <= node.clientWidth + 1,
        ),
      ).toBe(true);

      // Retained results must remain scrollable in a short window too.
      await page.setViewportSize({ width, height: 480 });
      await showUsage(page);
      if (width === 390) await meter.tap();
      else await meter.click();
      await expect(receipt.getByText("$1.25", { exact: true })).toHaveCount(3);
      await expect
        .poll(() =>
          receipt.evaluate((node) => node.scrollHeight > node.clientHeight),
        )
        .toBe(true);
      await receipt.focus();
      await page.keyboard.press("End");
      await expect
        .poll(() =>
          receipt.evaluate((node) =>
            Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop),
          ),
        )
        .toBeLessThanOrEqual(2);
      await expect(
        receipt.getByText("123,456 / 1,000,000 (12%)", { exact: true }).last(),
      ).toBeInViewport();

      if (width === 390) {
        await page.keyboard.press("Home");
        await expect
          .poll(() => receipt.evaluate((node) => node.scrollTop))
          .toBe(0);
        const box = (await receipt.boundingBox())!;
        const cdp = await page.context().newCDPSession(page);
        const x = Math.round(box.x + box.width / 2),
          y = Math.round(box.y + box.height - 30);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        for (let step = 1; step <= 10; step++)
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: y - step * 18 }],
          });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await expect
          .poll(() => receipt.evaluate((node) => node.scrollTop))
          .toBeGreaterThan(0);
        await cdp.detach();
      }
      await page
        .getByRole("button", { name: "Dismiss /session result" })
        .last()
        .click();
      await expect(receipt.getByText("$1.25", { exact: true })).toHaveCount(2);
    });
  });
}
