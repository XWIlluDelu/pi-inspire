import { expect, type Locator, test } from "@playwright/test";
import { codemodeCalls } from "../../shared/tool-activity";
import { activityReadingMessages } from "../web/fixtures/activity-reading";
import { customMessageConfiguration } from "../web/fixtures/custom-message-presentation";
import { openEventSession } from "./support/host-events";
import { openFixtureSession, pairedPage } from "./support/navigation";
import {
  disclosureReadingOffset,
  textMarkOffsets,
} from "./support/text-baseline";

async function expectActivityMarksCentered(control: Locator) {
  // The nine cells span the matrix's complete box, including dim cells. Its
  // center is compared with letter ink, not just with the control's line box.
  await control.page().evaluate(() => document.fonts.ready);
  const offsets = await control.evaluate(textMarkOffsets, {
    label: ":scope > span:not(.activity-fold__matrix, .activity-fold__summary)",
    marks: ":scope > svg, :scope > .activity-fold__matrix",
  });
  expect(offsets.length).toBeGreaterThan(0);
  for (const offset of offsets) expect(Math.abs(offset)).toBeLessThan(0.5);
}

async function expectActivityArrowAtReadingEdge(control: Locator) {
  const reading = await control.evaluateHandle(
    (element) =>
      element
        .closest("[data-transcript-row]")!
        .nextElementSibling!.querySelector(".rich-text")!,
  );
  try {
    const offset = await control
      .locator("svg")
      .evaluate(disclosureReadingOffset, reading);
    // Chevron directions have different painted widths; both should read on
    // the prose edge, without forcing the indented Activity label onto it.
    expect(Math.abs(offset)).toBeLessThan(2);
  } finally {
    await reading.dispose();
  }
}

test("activity headers disclose across the row and keep Copy beside the label", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  await pairedPage(page);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  const fold = page.locator(".activity-fold").first();
  await fold.getByRole("button", { name: "Expand assistant activity" }).click();
  const card = fold.locator(".card--tool").first();
  const toggle = card.locator(".card__disclosure");
  const header = card.locator(".card__header");
  if ((await toggle.getAttribute("aria-expanded")) === "true")
    await toggle.click();

  await header.click({
    position: { x: (await header.boundingBox())!.width - 24, y: 12 },
  });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const copy = header.locator(".card__copy");
  await copy.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(toggle).toBeFocused();
  const geometry = await header.evaluate((header) => {
    const body = header.parentElement!.querySelector(".card__body")!;
    const bodyStyle = getComputedStyle(body);
    const bounds = (selector: string) =>
      header.querySelector(selector)!.getBoundingClientRect();
    const focus = getComputedStyle(
      header.querySelector(".card__disclosure")!,
      "::after",
    );
    return {
      leadingDisclosure:
        bounds(".card__chevron").right <= bounds(".card__icon").left,
      copyGap: bounds(".card__copy").left - bounds(".card__disclosure").right,
      readingOffset:
        body.getBoundingClientRect().left +
        Number.parseFloat(bodyStyle.paddingLeft) -
        bounds(".card__label").left,
      focusOutline: focus.outlineStyle,
      focusWidth: parseFloat(focus.width),
      rowWidth: header.clientWidth,
    };
  });
  expect(geometry.leadingDisclosure).toBe(true);
  expect(geometry.copyGap).toBeGreaterThan(0);
  expect(Math.abs(geometry.readingOffset)).toBeLessThanOrEqual(1);
  expect(geometry.focusOutline).toBe("solid");
  expect(geometry.focusWidth).toBeCloseTo(geometry.rowWidth);
  await copy.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("activity kind cues stay local, respect reduced motion and disclose with keyboard focus", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  const fold = page.locator(".activity-fold").first();
  const disclosure = fold.getByRole("button", {
    name: "Expand assistant activity",
  });
  await expect(disclosure).toBeVisible();
  await expectActivityMarksCentered(disclosure);
  const kind = fold.locator(".activity-fold__kind").first();
  // Unit tests establish which kinds are live. Here isolate the CSS animation
  // from the offline provider's timing and verify that it never moves the control.
  await kind.evaluate((element) =>
    element.classList.add("activity-fold__kind--live"),
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const frames = await kind.evaluate((element) => {
    return [0, 900].map((time) => {
      for (const animation of element.getAnimations()) {
        animation.pause();
        animation.currentTime = time;
      }
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        opacity: Number(style.opacity),
        width: box.width,
        height: box.height,
      };
    });
  });
  expect(frames[1]!.opacity).toBeGreaterThan(frames[0]!.opacity);
  expect(frames[0]!.width).toBe(frames[1]!.width);
  expect(frames[0]!.height).toBe(frames[1]!.height);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await kind.evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");

  await page.setViewportSize({ width: 320, height: 1000 });
  await disclosure.scrollIntoViewIfNeeded();
  await expectActivityArrowAtReadingEdge(disclosure);
  await disclosure.focus();
  await disclosure.press("Enter");
  const content = fold.locator(".activity-fold__content");
  await expect(content).toBeVisible();
  const upper = fold.locator(".activity-fold__boundary--upper");
  await expectActivityArrowAtReadingEdge(upper);
  await expectActivityMarksCentered(upper);
  expect(
    await fold.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  const lower = fold.getByRole("button", {
    name: "Collapse assistant activity from the lower boundary",
  });
  await lower.focus();
  expect(
    await lower.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");
  await lower.press("Enter");
  await expect(disclosure).toBeFocused();
  await expect(content).toBeHidden();
});

test("Thinking copy follows disclosure and custom messages stay independent", async ({
  page,
}) => {
  const send = await openEventSession(
    page,
    "Activity reading",
    customMessageConfiguration,
    {
      theme: "light",
      palette: "wisteria",
      toolVisibility: "compact",
      thinkingVisibility: "collapsed",
      activityFoldVisibility: "expanded",
    },
  );
  send(
    ...activityReadingMessages().map((message) => ({
      type: "message_end",
      message,
    })),
  );
  const extension = page.getByRole("article", {
    name: "Inspire: composer editing",
  });
  await expect(extension).toContainText("Review notes");
  const thinking = page.locator(".card--thinking").first();
  await page.setViewportSize({ width: 320, height: 1100 });
  const copy = thinking.getByRole("button", {
    name: "Copy thinking block",
    exact: true,
  });
  await expect(copy).toHaveCount(0);
  await thinking
    .getByRole("button", { name: "Expand Thinking", exact: true })
    .click();
  await expect(thinking.locator(".card__body")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const rhythm = await thinking.evaluate((el) => {
    const title = el.querySelector(".card__label")!.getBoundingClientRect();
    const disclosure = el
      .querySelector(".card__disclosure")!
      .getBoundingClientRect();
    const copy = el.querySelector(".card__copy")!.getBoundingClientRect();
    const paragraphs = [...el.querySelectorAll("p")].map((p) =>
      p.getBoundingClientRect(),
    );
    return {
      copyGap: copy.left - disclosure.right,
      indent: paragraphs[0]!.left - title.left,
      paragraphGap: paragraphs[1]!.top - paragraphs[0]!.bottom,
    };
  });
  expect(rhythm.copyGap).toBeGreaterThan(0);
  expect(Math.abs(rhythm.indent)).toBeLessThanOrEqual(1);
  expect(rhythm.paragraphGap).toBeGreaterThan(0);
  expect(rhythm.paragraphGap).toBeLessThanOrEqual(8);
  await copy.focus();
  await expect(copy).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    thinking.getByRole("button", { name: "Collapse Thinking", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await thinking
    .getByRole("button", { name: "Collapse Thinking", exact: true })
    .click();
  await expect(copy).toHaveCount(0);
  expect(
    await thinking.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  const group = page.locator(".activity-fold").first();
  await group
    .getByRole("button", {
      name: "Collapse assistant activity from the lower boundary",
    })
    .click();
  await expect(extension).toBeVisible();
  await expect(extension).toContainText("The keyboard checks are complete.");
});

test("success and failure cues retain semantic color in tools and nested calls", async ({
  page,
}) => {
  const send = await openEventSession(
    page,
    "Activity states",
    customMessageConfiguration,
    {
      activityFoldVisibility: "expanded",
      toolVisibility: "compact",
    },
  );
  const messages = activityReadingMessages();
  const code = messages.find(
    (message) =>
      message.role === "toolResult" &&
      "toolCallId" in message &&
      message.toolCallId === "reading-code",
  ) as { details: { calls: Record<string, unknown>[] } } | undefined;
  if (!code || !("details" in code) || !code.details?.calls)
    throw new Error("Missing nested activity fixture");
  code.details.calls.push(
    {
      id: "failed-child",
      name: "preview_check",
      args: "{}",
      status: "error",
      durationMs: 30,
    },
    {
      id: "cancelled-child",
      name: "read",
      args: '{"path":"notes.md"}',
      status: "cancelled",
    },
  );
  // Model-call preview strings are intentionally not an expandable argument
  // payload, so this completed call has no detail control.
  code.details.calls.push({
    id: "model-complete",
    name: "models.classify",
    args: "fixture/classifier",
    status: "ok",
  });
  send(
    ...messages.map((message) => ({
      type: "message_end",
      message:
        message === code
          ? { ...message, __inspireCalls: codemodeCalls(code.details) }
          : message,
    })),
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "not-executed",
            name: "read",
            arguments: { path: "notes.md" },
            __inspireToolCall: {
              phase: "interrupted",
              characters: 20,
              truncated: false,
            },
          },
          {
            type: "toolCall",
            id: "unrecorded",
            name: "read",
            arguments: { path: "notes.md" },
          },
        ],
      },
    },
  );
  for (const label of ["not executed", "no result"]) {
    const mark = page.getByLabel(label, { exact: true });
    await expect(mark).toHaveAttribute("data-status", "neutral");
    await expect(mark).toHaveCSS("animation-name", "none");
  }
  const codeCard = page
    .locator(".card--tool")
    .filter({ hasText: "CodeMode" })
    .first();
  await codeCard.locator(".card__disclosure").click();
  await expect(codeCard.locator(".child-call__status--error")).toBeVisible();
  const detail = codeCard.locator("details.child-call").first();
  await detail.locator("summary").click();
  await expect(detail.locator(".child-call__detail")).toBeVisible();
  await page.setViewportSize({ width: 320, height: 1000 });
  const alignment = await codeCard.evaluate((element) => {
    const detail = element.querySelector("details.child-call[open]")!;
    const name = detail
      .querySelector(".child-call__name")!
      .getBoundingClientRect();
    const status = detail
      .querySelector(".child-call__status")!
      .getBoundingClientRect();
    const arrow = detail
      .querySelector(".child-call__chevron")!
      .getBoundingClientRect();
    const body = detail.querySelector(".child-call__detail")!;
    const plainName = element
      .querySelector(".child-call > div.child-call__row .child-call__name")!
      .getBoundingClientRect();
    return {
      nameColumnOffset: plainName.left - name.left,
      leading: arrow.right <= name.left,
      trailingStatus: name.right <= status.left,
      nameOffset:
        body.getBoundingClientRect().left +
        parseFloat(getComputedStyle(body).paddingLeft) -
        name.left,
      overflow: element.scrollWidth > element.clientWidth + 1,
    };
  });
  expect(alignment.leading).toBe(true);
  expect(alignment.trailingStatus).toBe(true);
  expect(Math.abs(alignment.nameColumnOffset)).toBeLessThanOrEqual(1);
  expect(Math.abs(alignment.nameOffset)).toBeLessThanOrEqual(1);
  expect(alignment.overflow).toBe(false);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    for (const [selector, token] of [
      [".card--thinking .card__icon", "--activity-think"],
      [".card--tool .card__icon", "--activity-tool"],
      [".card__status .status-success", "--success"],
      [".card__status .status-error", "--error"],
      [".child-call__status--ok", "--success"],
      [".child-call__status--error", "--error"],
      ['.card__status .pi-status[data-status="neutral"]', "--muted"],
      [".child-call__status--cancelled", "--muted"],
    ]) {
      const cue = page.locator(selector!).first();
      await expect(cue).toBeVisible();
      const colors = await cue.evaluate((element, token) => {
        const sample = document.createElement("span");
        sample.style.color = `var(${token})`;
        element.append(sample);
        const colors = {
          actual: getComputedStyle(element).color,
          semantic: getComputedStyle(sample).color,
        };
        sample.remove();
        return colors;
      }, token!);
      expect(colors.actual).toBe(colors.semantic);
    }
  }
});

test.describe("touch activity disclosures", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("tap feedback clears without a selected row and keyboard focus remains visible", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const send = await openEventSession(
      page,
      "Touch disclosures",
      customMessageConfiguration,
      {
        thinkingVisibility: "collapsed",
        toolVisibility: "compact",
        activityFoldVisibility: "expanded",
      },
    );
    send(
      ...activityReadingMessages().map((message) => ({
        type: "message_end",
        message,
      })),
      {
        type: "message_end",
        message: {
          role: "compactionSummary",
          summary: "Magic Context compacted: Keep the interaction decisions.",
          __inspireCompactionSource: "magic-context",
          __inspireMessageId: "touch-checkpoint",
          tokensBefore: 1842,
        },
      },
    );
    const thinking = page.locator(".card--thinking").first();
    const tool = page.locator(".card--tool").first();
    const checkpoint = page.locator(".context-checkpoint");
    for (const surface of [thinking, tool, checkpoint]) {
      const toggle = surface.locator(
        ".card__disclosure, .context-checkpoint__toggle",
      );
      const copy = surface.locator(".card__copy, .context-checkpoint__copy");
      await expect(copy).toHaveCount(0);
      const restingBackground = await toggle.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      const row = surface.locator(".card__header, .context-checkpoint__head");
      await row.tap({
        position: { x: (await row.boundingBox())!.width - 24, y: 12 },
      });
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(copy).toBeVisible();
      expect((await copy.boundingBox())!.width).toBeGreaterThanOrEqual(32);
      await copy.tap();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await toggle.tap();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(copy).toHaveCount(0);
      await expect(toggle).toHaveCSS("background-color", restingBackground);
      await toggle.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(toggle).toBeFocused();
      expect(
        await toggle.evaluate(
          (el) => getComputedStyle(el, "::after").outlineStyle,
        ),
      ).not.toBe("none");
    }
  });
});
