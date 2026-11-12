import { expect, test } from "@playwright/test";
import type { TranscriptPage } from "../../shared/contracts";
import { renderedColors } from "./support/colors";
import { routeSnapshots } from "./support/host-events";
import { openFixtureSession, pairedPage } from "./support/navigation";
import { firstTextBaseline } from "./support/text-baseline";

// These suites own mocked Host responses, not Service Worker fetch handling.
test.use({ serviceWorkers: "block" });

test("earlier conversation pages retry explicitly and preserve the reading position", async ({
  page,
}) => {
  const sessionId = "fixture-history";
  const rows = (label: string, start: number) =>
    Array.from({ length: 14 }, (_, index) => ({
      role: "user",
      content: `${label} ${index + 1}`,
      timestamp: start + index,
      __inspireMessageId: `paging-${start + index}`,
    }));
  let latestPage: TranscriptPage;
  const transport = await routeSnapshots(page, {
    snapshot(snapshot) {
      if (snapshot.active?.sessionId !== sessionId) return;
      latestPage = {
        ...snapshot.active.transcriptPage,
        messages: rows("Current page", 30),
        hasOlder: true,
        olderCursor: "page-one",
      };
      snapshot.active.transcriptPage = latestPage;
    },
  });
  const cursors: string[] = [];
  await page.route("**/api/transcript/older?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("sessionId")).toBe(sessionId);
    const cursor = params.get("cursor")!;
    cursors.push(cursor);
    if (cursors.length === 1)
      return route.fulfill({
        status: 403,
        json: { error: "Earlier messages unavailable" },
      });
    const first = cursor === "page-one";
    return route.fulfill({
      json: {
        ...latestPage,
        messages: rows(first ? "Earlier page" : "Oldest page", first ? 15 : 0),
        hasOlder: first,
        olderCursor: first ? "page-two" : null,
      },
    });
  });

  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  await expect.poll(() => transport.ready(sessionId)).toBe(true);
  const log = page.getByRole("log");
  const anchor = log.getByText("Current page 1", { exact: true });
  const readEarlier = async () => {
    await log.hover();
    await page.mouse.wheel(0, -10_000);
  };
  await expect(
    log.getByText("Current page 14", { exact: true }),
  ).toBeInViewport();
  expect(cursors).toEqual([]);
  await readEarlier();
  const retry = log.getByRole("button", {
    name: "Retry loading earlier messages",
  });
  await expect(retry).toHaveAttribute("title", "Earlier messages unavailable");
  await readEarlier();
  expect(cursors).toEqual(["page-one"]);
  await retry.click();
  await expect(log.getByText("Earlier page 1", { exact: true })).toBeAttached();
  await expect(anchor).toBeInViewport();

  transport.send({
    type: "message_end",
    sessionId,
    message: { role: "user", content: "Live append", timestamp: 50 },
  });
  await expect(log.getByText("Live append", { exact: true })).toBeAttached();
  await expect(anchor).toBeInViewport();
  await readEarlier();
  await expect(log.getByText("Oldest page 1", { exact: true })).toBeAttached();
  await expect(retry).toHaveCount(0);
  expect(cursors).toEqual(["page-one", "page-one", "page-two"]);
});

test("prompt outline metadata stays readable and shares the first-line text baseline", {
  tag: "@platform-ui",
}, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const count = (ordinal: number) =>
    ordinal % 3 === 2 ? 12 : (ordinal % 3) + 1;
  await routeSnapshots(page, {
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
  await page.setViewportSize({ width: 320, height: 900 });
  await pairedPage(page);
  await openFixtureSession(page, /Prompt map long-session fixture/);
  await page.getByRole("button", { name: "Open prompt navigation" }).click();
  await page
    .getByRole("button", { name: "Open prompt map", exact: true })
    .click();
  await page.evaluate(() => document.fonts.ready);
  const map = page.locator(".prompt-map");
  const rows = map.locator(".prompt-map__turn");
  await expect(
    rows.filter({ hasText: /12 attachments/ }).first(),
  ).toBeAttached();
  const row = rows.filter({ hasText: /12 attachments/ }).first();
  const snippet = await row
    .locator(".prompt-map__snippet")
    .evaluate(firstTextBaseline, ".prompt-map__turn");
  for (const selector of [".prompt-map__ordinal", ".prompt-map__attachments"]) {
    const metadata = await row
      .locator(selector)
      .evaluate(firstTextBaseline, ".prompt-map__turn");
    expect(Math.abs(metadata! - snippet!)).toBeLessThanOrEqual(0.5);
    expect(
      (await renderedColors(row.locator(selector))).contrast,
    ).toBeGreaterThanOrEqual(4.5);
  }
  expect(
    await row.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await row.focus();
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();
});

test("floating desktop reading controls preserve the viewport and keyboard order", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await pairedPage(page);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  const log = page.getByRole("log");
  const wrap = page.locator(".transcript-wrap");
  const latest = page.getByRole("button", { name: "Jump to latest" });
  const search = page.getByRole("searchbox", { name: "Search conversation" });
  await expect(
    page.getByRole("heading", { name: "A compact result" }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const viewport = (await log.boundingBox())!;
  const map = (await page.locator(".prompt-map").boundingBox())!;
  const column = (await log
    .locator(".transcript__column")
    .first()
    .boundingBox())!;
  expect(map.x).toBeGreaterThan(viewport.x);
  expect(map.x + map.width).toBeLessThan(column.x);

  await log.hover();
  await page.mouse.wheel(0, -2000);
  await expect(latest).toBeVisible();
  const button = (await latest.boundingBox())!;
  expect(
    Math.abs(button.x + button.width / 2 - viewport.x - viewport.width / 2),
  ).toBeLessThan(1);
  expect(button.y).toBeGreaterThan(viewport.y + viewport.height / 2);
  expect(button.y + button.height).toBeLessThan(viewport.y + viewport.height);
  const beforeSearch = await log.evaluate((el) => el.scrollTop);
  await wrap.press("Control+f");
  await expect(search).toBeFocused();
  expect(await log.evaluate((el) => el.scrollTop)).toBe(beforeSearch);
  expect(await log.boundingBox()).toEqual(viewport);
  await search.press("Escape");

  await log
    .getByRole("button", { name: "Expand assistant activity", exact: true })
    .first()
    .click();
  await expect(latest).toBeVisible();

  await wrap.focus();
  let reachedMessages = false;
  let visitedPromptMap = false;
  const tabStops = await wrap
    .locator("button, input, a[href], [tabindex='0']")
    .count();
  for (let step = 0; step <= tabStops; step++) {
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
  await log
    .locator("button, a[href]")
    .last()
    .evaluate((el: HTMLElement) => el.focus({ preventScroll: true }));
  await page.keyboard.press("Tab");
  await expect(latest).toBeFocused();

  await latest.click();
  await expect(latest).toBeHidden();
  await expect
    .poll(() =>
      log.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThanOrEqual(1);
  expect(await log.boundingBox()).toEqual(viewport);
});

test("prompt map navigates user turns and adapts to the narrow workbench", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(page, /Prompt map long-session fixture/);
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
  await expect(map.locator(".prompt-map__tick--active")).toHaveAttribute(
    "data-prompt-ordinal",
    "12",
  );
  const toggle = map.getByRole("button", { name: "Open prompt map" });
  const list = page.locator(".prompt-map__list");
  await toggle.hover();
  await expect(list).toBeVisible();
  await page.locator(".topbar__title").hover();
  await expect(list).toBeHidden();

  await page.setViewportSize({ width: 1_280, height: 640 });
  const mark = map.locator(".prompt-map__tick--active");
  const readEarlier = await transcript.evaluate((element) => {
    const prompt = element.querySelector('[data-user-turn-index="4"]')!;
    const readingTop = element.getBoundingClientRect().top;
    return prompt.getBoundingClientRect().top - readingTop - 100;
  });
  await transcript.hover();
  await page.mouse.wheel(0, readEarlier);
  await expect(mark).toHaveAttribute("data-prompt-ordinal", "4");
  await next.click();
  await expect(mark).toHaveAttribute("data-prompt-ordinal", "5");
  await previous.click();
  await expect(mark).toHaveAttribute("data-prompt-ordinal", "4");

  await toggle.click();
  const firstPrompt = list.getByRole("button", {
    name: /^1\. Prompt map fixture turn 1/,
  });
  await firstPrompt.click();
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect(previous).toBeDisabled();

  await toggle.click();
  await list
    .getByRole("button", { name: /^13\. Prompt map fixture turn 13/ })
    .click();
  await expect(next).toBeDisabled();
  await expect(previous).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 780 });
  await expect(map).toBeHidden();
  const searchLauncher = page.getByRole("button", {
    name: "Open conversation search",
    exact: true,
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

  const wrap = page.locator(".transcript-wrap");
  await wrap.focus();
  await page.keyboard.press("Tab");
  await expect(promptLauncher).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(searchLauncher).toBeFocused();

  const beforeMap = await transcript.evaluate((el) => el.scrollTop);
  await promptLauncher.click();
  await expect(map).toBeVisible();
  expect(await transcript.evaluate((el) => el.scrollTop)).toBe(beforeMap);
  await expect(list).toBeHidden();
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
  await page.getByRole("textbox", { name: "Message", exact: true }).click();
  await expect(map).toBeHidden();
  await expect(promptLauncher).toBeVisible();
});

test("the reading scrollbar stays in the narrow gutter and responds to drag and wheel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  const log = page.getByRole("log");
  const rail = page.locator(".transcript-wrap > .srail");
  const thumb = rail.locator(".srail__thumb");
  await log.locator("pre").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await expect(rail).toBeVisible();

  for (const fraction of [0, 1]) {
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
    const thumb = rail.querySelector(".srail__thumb")!.getBoundingClientRect();
    const viewport = el.getBoundingClientRect();
    const range = el.scrollHeight - el.clientHeight;
    const codeCenter = el.scrollTop + code.top - viewport.top + code.height / 2;
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
