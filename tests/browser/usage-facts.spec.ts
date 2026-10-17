import { expect, type Page, test } from "@playwright/test";
import { HISTORY_FIXTURE_SESSION_ID } from "../../server/mock-history";
import type { ActiveSnapshot } from "../../shared/contracts";
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
    test("anchors the occupancy ring as unknown and numeric readings change", async ({
      page,
    }) => {
      let source!: ActiveSnapshot;
      let envelope!: { type: string };
      const transport = await routeMockSnapshots(page, {
        snapshot(snapshot) {
          if (snapshot.active) source = structuredClone(snapshot);
        },
        event(event) {
          if (event.type === "snapshot") envelope = { ...event };
        },
      });
      await pairedPage(page);
      await openMockSession(page, /Calibration history fixture/);
      await expect
        .poll(() => source?.active?.sessionId)
        .toBe(HISTORY_FIXTURE_SESSION_ID);
      await expect.poll(() => envelope?.type).toBe("snapshot");
      await page.evaluate(() => document.fonts.ready);
      const meter = page.getByRole("button", {
        name: /^Session & usage, context/,
      });
      const setUsage = (percent: number | null, running: boolean) => {
        const next = structuredClone(source);
        next.runState = running ? "running" : "idle";
        next.active!.isStreaming = running;
        next.sessionStatuses[next.active!.sessionId] = {
          runState: next.runState,
        };
        next.active!.stats = {
          contextUsage: {
            tokens: percent === null ? null : percent * 2000,
            contextWindow: 200_000,
            percent,
          },
        };
        transport.send({ ...envelope, unchanged: false, data: next });
      };
      for (const running of [false, true]) {
        let anchor: { ring: number; send: number } | undefined;
        for (const percent of [null, 0, 9, 85, 100, 150]) {
          setUsage(percent, running);
          await expect(meter).toHaveAccessibleName(
            `Session & usage, context ${percent === null ? "unknown" : percent + " percent full"}`,
          );
          await expect(
            page.getByRole("button", { name: "Abort running task" }),
          ).toHaveCount(running ? 1 : 0);
          const ring = (await page.locator(".meter__ring").boundingBox())!;
          const send = (await page
            .locator(".composer__send")
            .last()
            .boundingBox())!;
          if (anchor) {
            expect(ring.x).toBeCloseTo(anchor.ring, 1);
            expect(send.x).toBeCloseTo(anchor.send, 1);
          } else anchor = { ring: ring.x, send: send.x };
          expect(
            Math.abs(ring.y + ring.height / 2 - send.y - send.height / 2),
          ).toBeLessThan(0.5);
          expect(
            await page
              .locator(".composer")
              .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          ).toBe(true);
        }
      }
      // Native values beyond the reserved three digits must still be readable.
      setUsage(1200, true);
      const value = meter.locator(".meter__value");
      await expect(value).toHaveText("1200%");
      expect(
        await value.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
      await meter.focus();
      await expect(page.getByRole("tooltip")).toContainText("1200%");
      await meter.press("Escape");
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await expect(meter).toBeFocused();
    });

    test("refreshes usage in place and scrolls distinct query results without losing the draft", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      let currentSnapshot!: ActiveSnapshot;
      let snapshotEvent!: { type: string };
      const transport = await routeMockSnapshots(page, {
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
          currentSnapshot = structuredClone(snapshot);
        },
        event(event) {
          if (event.type === "snapshot") snapshotEvent = { ...event };
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

      const usage = receipt.getByRole("status");
      const originalCard = await usage.elementHandle();
      const originalHeight = (await receipt.boundingBox())!.height;
      await expect
        .poll(() => currentSnapshot?.active?.sessionId)
        .toBe(HISTORY_FIXTURE_SESSION_ID);
      await expect.poll(() => snapshotEvent?.type).toBe("snapshot");
      // Keep the Host envelope, including when its handshake acknowledged an unchanged snapshot.
      transport.send({
        ...snapshotEvent,
        unchanged: false,
        data: {
          ...currentSnapshot,
          active: {
            ...currentSnapshot.active!,
            stats: {
              totalMessages: 12,
              tokens: { total: 9_000_000 },
              cost: 2.5,
              contextUsage: {
                tokens: 250_000,
                contextWindow: 1_000_000,
                percent: 25,
              },
            },
          },
        },
      });
      await expect(meter).toHaveAccessibleName(
        "Session & usage, context 25 percent full",
      );
      await showUsage(page);
      await expect(usage).toHaveCount(1);
      await expect(usage).toContainText("$2.50");
      await expect(usage).toContainText("250,000 / 1,000,000 (25%)");
      if (width === 390) await meter.tap();
      else await meter.click();
      await expect(usage).toHaveCount(1);
      expect(await originalCard!.evaluate((card) => card.isConnected)).toBe(
        true,
      );
      expect((await receipt.boundingBox())!.height).toBeCloseTo(originalHeight);
      await expect(input).toHaveValue("Keep this draft");

      // Different queries retain independent results; repeating /session does not.
      await page.setViewportSize({ width, height: 480 });
      await input.fill("/name");
      await page.locator(".composer__send").click();
      await expect(receipt.getByText("/name", { exact: true })).toBeVisible();
      await input.fill("Keep this draft");
      const palette = await openCommandPalette(page);
      await palette.getByLabel("Filter commands").fill("/quit");
      await palette.getByRole("option", { name: /Leave Inspire/ }).click();
      const quit = receipt.getByText(
        "Close this browser tab when you are done. The Host and persistent Pi sessions keep running so you can reconnect later.",
        { exact: true },
      );
      await expect(quit).toBeVisible();
      await expect(receipt.getByRole("status")).toHaveCount(3);
      await expect(input).toHaveValue("Keep this draft");

      await expect
        .poll(() =>
          receipt.evaluate((node) => node.scrollHeight > node.clientHeight),
        )
        .toBe(true);
      await receipt.focus();
      await expect(receipt).toBeFocused();
      await receipt.press("End");
      await expect
        .poll(() =>
          receipt.evaluate((node) =>
            Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop),
          ),
        )
        .toBeLessThanOrEqual(2);
      await expect(quit).toBeInViewport();

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
      await receipt
        .getByRole("button", { name: "Dismiss /quit result" })
        .click();
      await expect(quit).toHaveCount(0);
      await expect(receipt.getByRole("status")).toHaveCount(2);
      await expect(receipt.getByText("$2.50", { exact: true })).toHaveCount(1);
      await expect(receipt.getByText("/name", { exact: true })).toHaveCount(1);
      await expect(input).toHaveValue("Keep this draft");
    });
  });
}
