import { expect, test } from "@playwright/test";
import { activityReadingMessages } from "../web/fixtures/activity-reading";
import { customMessageConfiguration } from "../web/fixtures/custom-message-presentation";
import { openMockEventSession } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";

test("the full activity header discloses content with Copy beside its text", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const fold = page.locator(".activity-fold").first();
  await fold.getByRole("button", { name: "Expand assistant activity" }).click();
  const card = fold.locator(".card").first();
  const toggle = card.locator(".card__disclosure");
  const header = card.locator(".card__header");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    if ((await toggle.getAttribute("aria-expanded")) === "true")
      await toggle.click();
    // The blank end of a closed row belongs to the native disclosure, not
    // an unlabelled parent click handler or the small identity button alone.
    await header.click({
      position: { x: (await header.boundingBox())!.width - 24, y: 12 },
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await header.hover();
    const geometry = await header.evaluate((element) => {
      const copy = element
        .querySelector<HTMLElement>(".card__copy")!
        .getBoundingClientRect();
      const body = element
        .parentElement!.querySelector(".card__body")!
        .getBoundingClientRect();
      const arrow = element
        .querySelector(".card__chevron")!
        .getBoundingClientRect();
      const icon = element
        .querySelector(".card__icon")!
        .getBoundingClientRect();
      return {
        leadingDisclosure: arrow.right <= icon.left,
        copyGap:
          copy.left -
          element.querySelector(".card__disclosure")!.getBoundingClientRect()
            .right,
        bodyIndent: body.left - element.getBoundingClientRect().left,
        bodyBackground: getComputedStyle(
          element.parentElement!.querySelector(".card__body")!,
        ).backgroundColor,
        bodyBorder: getComputedStyle(
          element.parentElement!.querySelector(".card__body")!,
        ).borderLeftWidth,
        readingOffset:
          body.left +
          Number.parseFloat(
            getComputedStyle(
              element.parentElement!.querySelector(".card__body")!,
            ).paddingLeft,
          ) +
          Number.parseFloat(
            getComputedStyle(
              element.parentElement!.querySelector(".card__body")!,
            ).borderLeftWidth,
          ) -
          element.querySelector(".card__label")!.getBoundingClientRect().left,
        shadow: getComputedStyle(element).boxShadow,
        overflow: element.scrollWidth > element.clientWidth + 1,
      };
    });
    expect(geometry.leadingDisclosure).toBe(true);
    expect(geometry.copyGap).toBeGreaterThanOrEqual(4);
    expect(geometry.copyGap).toBeLessThanOrEqual(8);
    expect(Math.abs(geometry.bodyIndent)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.readingOffset)).toBeLessThanOrEqual(1);
    expect(geometry.bodyBackground).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.bodyBorder).toBe("0px");
    expect(geometry.shadow).toBe("none");
    expect(geometry.overflow).toBe(false);
    await expect(header).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const hierarchy = await fold.evaluate((element) => {
      const upper = getComputedStyle(
        element.querySelector(".activity-fold__boundary--upper")!,
      );
      const lower = getComputedStyle(
        element.querySelector(".activity-fold__boundary--lower")!,
      );
      const item = getComputedStyle(element.querySelector(".card__label")!);
      return {
        groupSize: parseFloat(upper.fontSize),
        groupWeight: parseFloat(upper.fontWeight),
        actionSize: parseFloat(lower.fontSize),
        itemSize: parseFloat(item.fontSize),
        itemWeight: parseFloat(item.fontWeight),
      };
    });
    expect(hierarchy.groupSize).toBeGreaterThan(hierarchy.itemSize);
    expect(hierarchy.groupWeight).toBeLessThanOrEqual(hierarchy.itemWeight);
    expect(hierarchy.actionSize).toBeGreaterThanOrEqual(hierarchy.itemSize);
    const copy = header.locator(".card__copy");
    await copy.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(toggle).toBeFocused();
    const focus = await toggle.evaluate((element) => ({
      outline: getComputedStyle(element, "::after").outlineStyle,
      width: Number.parseFloat(getComputedStyle(element, "::after").width),
      rowWidth: element.parentElement!.clientWidth,
    }));
    expect(focus.outline).toBe("solid");
    expect(focus.width).toBeCloseTo(focus.rowWidth);
    await copy.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await header.click({
      position: { x: (await header.boundingBox())!.width - 24, y: 12 },
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  }
});

test("activity kind cues stay local, respect reduced motion and disclose with keyboard focus", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const fold = page.locator(".activity-fold").first();
  const disclosure = fold.getByRole("button", {
    name: "Expand assistant activity",
  });
  await expect(disclosure).toBeVisible();
  await expect(fold.locator(".activity-fold__rail")).toHaveCount(0);
  const kind = fold.locator(".activity-fold__kind").first();
  // Unit tests establish which kinds are live. Here isolate the CSS animation
  // from the mock worker's timing and verify that it never moves the control.
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

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await disclosure.scrollIntoViewIfNeeded();
    await disclosure.focus();
    await disclosure.press("Enter");
    const content = fold.locator(".activity-fold__content");
    await expect(content).toBeVisible();
    const groupingGaps = await content.evaluate((element) => [
      getComputedStyle(element).rowGap,
      ...Array.from(
        element.querySelectorAll(".assistant-doc"),
        (document) => getComputedStyle(document).rowGap,
      ),
    ]);
    expect(groupingGaps.length).toBeGreaterThan(1);
    expect(new Set(groupingGaps).size).toBe(1);
    const itemPaint = await fold
      .locator(".card")
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          border: style.borderLeftWidth,
          background: style.backgroundColor,
        };
      });
    expect(itemPaint).toEqual({
      border: "0px",
      background: "rgba(0, 0, 0, 0)",
    });
    expect(
      await fold.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    const lower = fold.getByRole("button", {
      name: "Collapse assistant activity from the lower boundary",
    });
    await lower.scrollIntoViewIfNeeded();
    await lower.focus();
    expect(
      await lower.evaluate((element) => getComputedStyle(element).outlineStyle),
    ).not.toBe("none");
    await lower.press("Enter");
    await expect(disclosure).toBeFocused();
    await expect(content).toBeHidden();
  }
});

test("activity Copy is available only with expanded content and custom messages stay independent", async ({
  page,
}) => {
  const send = await openMockEventSession(
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
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    const copy = thinking.getByRole("button", {
      name: "Copy thinking block",
      exact: true,
    });
    await expect(copy).toHaveCount(0);
    await thinking
      .getByRole("button", { name: "Expand Thinking", exact: true })
      .click();
    await expect(thinking.locator(".card__body")).toBeVisible();
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
  }
  for (const card of await page.locator(".card--tool").all()) {
    const copy = card.locator(".card__copy");
    await expect(copy).toHaveCount(0);
    await card.locator(".card__disclosure").click();
    await expect(card.locator(".card__body")).toBeVisible();
    const gap = await copy.evaluate(
      (element) =>
        element.getBoundingClientRect().left -
        element.previousElementSibling!.getBoundingClientRect().right,
    );
    expect(gap).toBeGreaterThanOrEqual(4);
    expect(gap).toBeLessThanOrEqual(8);
    await copy.focus();
    await expect(copy).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(card.locator(".card__disclosure")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      await card.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await card.locator(".card__disclosure").click();
    await expect(copy).toHaveCount(0);
  }
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
  const send = await openMockEventSession(
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
  );
  if (!code || !("details" in code) || !code.details?.calls)
    throw new Error("Missing nested activity fixture");
  code.details.calls.push({
    id: "failed-child",
    name: "preview_check",
    args: "{}",
    status: "error",
    durationMs: 30,
  });
  // Model-call preview strings are intentionally not an expandable argument
  // payload, so this completed call has no detail control.
  code.details.calls.push({
    id: "model-complete",
    name: "models.classify",
    args: "fixture/classifier",
    status: "ok",
  });
  send(...messages.map((message) => ({ type: "message_end", message })));
  const codeCard = page
    .locator(".card--tool")
    .filter({ hasText: "CodeMode" })
    .first();
  await codeCard.locator(".card__disclosure").click();
  await expect(codeCard.locator(".child-call__status--error")).toBeVisible();
  const detail = codeCard.locator("details.child-call").first();
  await detail.locator("summary").click();
  await expect(detail.locator(".child-call__detail")).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
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
      const plainStatus = element
        .querySelector(".child-call > div.child-call__row .child-call__status")!
        .getBoundingClientRect();
      return {
        statusOffset: plainStatus.left - status.left,
        leading: arrow.right <= status.left,
        nameOffset:
          body.getBoundingClientRect().left +
          parseFloat(getComputedStyle(body).paddingLeft) -
          name.left,
        overflow: element.scrollWidth > element.clientWidth + 1,
      };
    });
    expect(alignment.leading).toBe(true);
    expect(Math.abs(alignment.statusOffset)).toBeLessThanOrEqual(1);
    expect(Math.abs(alignment.nameOffset)).toBeLessThanOrEqual(1);
    expect(alignment.overflow).toBe(false);
  }
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    for (const [selector, token] of [
      [".card--thinking .card__icon", "--activity-think"],
      [".card--tool .card__icon", "--activity-tool"],
      [".card__label", "--ink"],
      [".card__status .status-success", "--success"],
      [".card__status .status-error", "--error"],
      [".child-call__status--ok", "--success"],
      [".child-call__status--error", "--error"],
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
    const send = await openMockEventSession(
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
      await expect(toggle).toHaveCSS(
        "-webkit-tap-highlight-color",
        "rgba(0, 0, 0, 0)",
      );
      const row = surface.locator(".card__header, .context-checkpoint__head");
      await row.tap({
        position: { x: (await row.boundingBox())!.width - 24, y: 12 },
      });
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(copy).toBeVisible();
      await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      expect((await copy.boundingBox())!.width).toBeGreaterThanOrEqual(32);
      await copy.tap();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(copy).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await row.tap({
        position: { x: (await row.boundingBox())!.width - 24, y: 12 },
      });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(copy).toHaveCount(0);
      await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
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
    await expect(thinking.locator(".card__header")).toHaveCSS(
      "-webkit-tap-highlight-color",
      "rgba(0, 0, 0, 0)",
    );
    const group = page.locator(".activity-fold").first();
    await group
      .getByRole("button", {
        name: "Collapse assistant activity from the upper boundary",
      })
      .tap();
    const groupToggle = group.getByRole("button", {
      name: "Expand assistant activity",
      exact: true,
    });
    await expect(groupToggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(groupToggle).toHaveCSS(
      "-webkit-tap-highlight-color",
      "rgba(0, 0, 0, 0)",
    );
  });
});
