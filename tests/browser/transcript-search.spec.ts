import { expect, type Response, test } from "@playwright/test";
import { checkpointAdapterConfiguration } from "../web/fixtures/extension-adapters";
import { openEventSession } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import {
  openCommandPalette,
  openConversationSearch,
} from "./support/navigation";
import { terminalMutationHeaders } from "./support/terminal-operations";

const configuration = checkpointAdapterConfiguration;
const current = () => {
  const range = CSS.highlights.get("transcript-current-match")?.values().next()
    .value as Range | undefined;
  if (!range) return null;
  return {
    text: range.toString(),
    code: !!range.startContainer.parentElement?.closest("code"),
    y: range.getBoundingClientRect().top,
  };
};

test("@cross-browser conversation search keeps its anchor and separates results from navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 850 });
  const emit = await openEventSession(
    page,
    "Conversation search geometry",
    configuration,
    {},
  );
  const text = Array.from({ length: 12 }, () => "calibration").join(" ");
  emit({
    type: "message_end",
    message: { role: "user", content: text, timestamp: 1 },
  });
  const input = await openConversationSearch(page);
  await page.evaluate(() => document.fonts.ready);
  const search = page.getByRole("search", { name: "Search conversation" });
  const result = search.getByRole("status", {
    name: "Transcript search matches",
  });
  const count = search.locator(".transcript-search__count");
  const previous = search.getByRole("button", {
    name: "Previous transcript match",
  });
  const next = search.getByRole("button", { name: "Next transcript match" });
  const before = await search.boundingBox();
  const fieldStart = (await input.boundingBox())!.x;
  const nextStart = (await next.boundingBox())!.x;

  await input.fill("calibration");
  await expect(result).toHaveText("12 matches");
  expect(await search.boundingBox()).toEqual(before);
  expect((await input.boundingBox())!.x).toBe(fieldStart);
  expect((await next.boundingBox())!.x).toBe(nextStart);

  await page.setViewportSize({ width: 901, height: 850 });
  const expand = page.getByRole("button", {
    name: "Expand navigation",
    exact: true,
  });
  if (await expand.isVisible()) await expand.click();
  const context = page.getByRole("button", {
    name: "Toggle resources panel",
  });
  if ((await context.getAttribute("aria-expanded")) !== "true")
    await context.click();
  await expect(page.locator(".ctx")).toBeVisible();
  await expect(count).toHaveText("12");
  const previousBox = (await previous.boundingBox())!;
  const nextBox = (await next.boundingBox())!;
  expect(previousBox.width).toBeGreaterThanOrEqual(24);
  expect(previousBox.height).toBeGreaterThanOrEqual(24);
  expect(nextBox.width).toBeGreaterThanOrEqual(24);
  expect(nextBox.height).toBeGreaterThanOrEqual(24);
  expect(
    await count.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().right;
    }),
  ).toBeLessThan(previousBox.x);
  await input.focus();
  await page.keyboard.press("Tab");
  await expect(previous).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(result).toHaveText("1 of 12");
  await expect(count).toHaveText("1/12");
  await previous.press("Enter");
  await expect(result).toHaveText("12 of 12");
});

test("composition keys do not navigate transcript matches or dismiss search", async ({
  page,
}) => {
  const emit = await openEventSession(
    page,
    "Composition-owned search",
    configuration,
    {},
  );
  emit({
    type: "message_end",
    message: { role: "user", content: "测量一，测量二。", timestamp: 1 },
  });
  await openConversationSearch(page);
  const input = page.getByRole("searchbox", {
    name: "Search conversation",
    exact: true,
  });
  const result = page.getByLabel("Transcript search matches");
  await input.fill("测量");
  await expect(result).toHaveText("2 matches");
  await page.getByRole("button", { name: "Next transcript match" }).click();
  await expect(result).toHaveText("1 of 2");
  await input.focus();
  for (const ime of [
    { isComposing: true },
    { isComposing: false, keyCode: 229 },
  ]) {
    for (const key of ["Enter", "Escape"]) {
      expect(
        await input.evaluate(
          (el, init) =>
            el.dispatchEvent(
              new KeyboardEvent("keydown", {
                ...init,
                bubbles: true,
                cancelable: true,
              }),
            ),
          { key, ...ime },
        ),
      ).toBe(true);
      await expect(input).toBeFocused();
      await expect(result).toHaveText("1 of 2");
      await expect(input).toHaveValue("测量");
    }
  }
  await input.press("Enter");
  await expect(result).toHaveText("2 of 2");
  await input.press("Escape");
  await expect(input).toBeVisible();
  await expect(input).not.toBeFocused();
  await expect(input).toHaveValue("测量");
  await expect(result).toHaveText("2 of 2");
  const nativeFind = (element: Element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  const palette = await openCommandPalette(page);
  expect(await page.locator(".transcript").evaluate(nativeFind)).toBe(true);
  await expect(palette).toBeVisible();
  await expect(input).not.toBeFocused();
  await page.keyboard.press("Escape");
  const scope = page.getByRole("combobox", { name: "Search scope" });
  await scope.click();
  expect(await scope.evaluate(nativeFind)).toBe(true);
  await expect(scope).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");

  await page.locator(".transcript-wrap").press("Control+f");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("测量");
  expect(
    await input.evaluate((element: HTMLInputElement) =>
      element.value.slice(
        element.selectionStart ?? 0,
        element.selectionEnd ?? 0,
      ),
    ),
  ).toBe("测量");
  const desktop = page.viewportSize()!;
  const phone = { width: 390, height: desktop.height };
  await page.setViewportSize(phone);
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("测量");
  await page.setViewportSize(desktop);
  // Wait for the desktop transition to retire the open mobile tool before
  // clearing the query and resizing again.
  await expect(
    page.locator('button[aria-label="Open conversation search"]'),
  ).toBeAttached();
  await expect(input).toHaveValue("测量");
  await input.fill("");
  await expect(result).toHaveText("");
  await page.setViewportSize(phone);
  await expect(input).toBeHidden();
});

test("search counts rendered shell text and reveals a matching branch summary", async ({
  page,
}) => {
  const emit = await openEventSession(
    page,
    "Visible search text",
    configuration,
    {},
  );
  emit(
    {
      type: "message_end",
      message: {
        role: "bashExecution",
        command: "printf status",
        output: "\u001b[31mVisible status\u001b[0m",
        timestamp: 1,
      },
    },
    {
      type: "message_end",
      message: {
        role: "branchSummary",
        summary: "Reason for the fork",
        timestamp: 4,
      },
    },
  );
  await openConversationSearch(page);
  const search = page.getByRole("search", {
    name: "Search conversation",
  });
  const input = search.getByRole("searchbox", {
    name: "Search conversation",
  });
  await input.fill("31m");
  await expect(search).toContainText("0 matches");
  for (const query of ["Visible status", "Reason for the fork"]) {
    await input.fill(query);
    await expect(search.getByLabel("Transcript search matches")).toHaveText(
      "1 match",
    );
    await search.getByRole("button", { name: "Next transcript match" }).click();
    await expect(search).toContainText("1 of 1");
    await expect
      .poll(() => page.evaluate(current))
      .toMatchObject({ text: query });
  }
  const branch = page.getByRole("button", { name: "Branch context" });
  const copy = page.getByRole("button", { name: "Copy branch summary" });
  await expect(branch).toHaveAttribute("aria-expanded", "true");
  await expect(copy).toBeVisible();
  await branch.click();
  await expect(copy).toHaveCount(0);
  await input.press("Enter");
  await expect(branch).toHaveAttribute("aria-expanded", "true");
});

test("literal highlights track visible matches and open collapsed results", async ({
  page,
}) => {
  const emit = await openEventSession(
    page,
    "Search highlights",
    configuration,
    {},
  );
  const code = 'const value = "precise match";';
  const source =
    "# Searchable answer\n\nOne **precise match**, another *precise match*.\n\n" +
    Array.from(
      { length: 30 },
      (_, index) =>
        `Ordinary paragraph ${index}, separating the first and last occurrence.\n\n`,
    ).join("") +
    `\`\`\`ts\n${code}\n\`\`\`\n\n[Reference](https://example.com/hidden-path). One visible hidden-path.`;
  const messages = [
    { role: "user", content: "A precise match from the user." },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "precise match hidden from search" },
        { type: "text", text: source },
      ],
    },
    {
      role: "compactionSummary",
      summary: "The precise match is retained in the summary.",
    },
    {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage:
        "Earlier diagnostic line\n".repeat(60) + "Diagnostic precise match",
    },
  ];
  emit(
    ...messages.map((message, index) => ({
      type: "message_end",
      message: { ...message, timestamp: index + 1 },
    })),
  );
  const input = await openConversationSearch(page);
  const count = page.getByLabel("Transcript search matches");
  await input.fill("PRECISE MATCH");
  await expect(count).toHaveText("6 matches");
  await expect
    .poll(() =>
      page.evaluate(() => CSS.highlights.get("transcript-match")?.size),
    )
    .toBe(4);
  for (let match = 0; match < 4; match++) await input.press("Enter");
  await expect(count).toHaveText("4 of 6");
  await expect
    .poll(() => page.evaluate(current))
    .toMatchObject({
      text: "precise match",
      code: true,
    });
  const logBounds = (await page.getByRole("log").boundingBox())!;
  await expect
    .poll(async () => {
      const match = await page.evaluate(current);
      return (
        !!match &&
        match.y > logBounds.y &&
        match.y < logBounds.y + logBounds.height
      );
    })
    .toBe(true);

  await input.press("Enter");
  await expect(
    page.getByRole("button", { name: "Context compacted", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect
    .poll(() => page.evaluate(current))
    .toMatchObject({ text: "precise match" });
  await input.press("Enter");
  await expect(
    page.getByRole("button", { name: "Hide details" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const range = CSS.highlights
          .get("transcript-current-match")
          ?.values()
          .next().value as Range | undefined;
        const region = range?.startContainer.parentElement?.closest(
          ".assistant-error__message",
        );
        if (!range || !region) return false;
        const hit = range.getBoundingClientRect();
        const box = region.getBoundingClientRect();
        return hit.top >= box.top && hit.bottom <= box.bottom;
      }),
    )
    .toBe(true);
  // A source-only URL occurrence must not be falsely assigned to visible prose.
  await input.fill("hidden-path");
  await input.press("Enter");
  await expect(count).toHaveText("1 of 2");
  await expect
    .poll(() =>
      page.evaluate(() => CSS.highlights.get("transcript-match")?.size),
    )
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => CSS.highlights.get("transcript-current-match")?.size),
    )
    .toBe(0);

  const live = {
    role: "assistant",
    content: "Newly settled phrase",
    timestamp: 5,
    __inspireLiveId: "search-result-arrival",
  };
  await input.fill("newly settled phrase");
  emit({ type: "message_start", message: live });
  await expect(page.getByText("Newly settled phrase")).toBeVisible();
  await expect(count).toHaveText("0 matches");
  emit({ type: "message_end", message: { ...live, __inspireSettled: true } });
  await expect(count).toHaveText("1 match");
});

test("highlights recover when a searched virtual row mounts and clear on session change", async ({
  page,
}) => {
  const emit = await openEventSession(
    page,
    "Virtual search highlights",
    configuration,
    {},
  );
  emit(
    ...Array.from({ length: 80 }, (_, index) => ({
      type: "message_end",
      message: {
        role: "user",
        content:
          index === 2
            ? "Find this unique older phrase."
            : `Ordinary prompt ${index}.`,
        timestamp: index + 1,
      },
    })),
  );
  await expect(page.locator(".transcript__column--virtual")).toBeVisible();
  await openConversationSearch(page);
  const input = page.getByRole("searchbox", { name: "Search conversation" });
  // Count the whole projection, including rows outside the virtual DOM window.
  await input.fill("Ordinary prompt");
  await expect(
    page.getByRole("status", { name: "Transcript search matches" }),
  ).toHaveText("79 matches");
  await input.fill("unique older");
  await expect(
    page.getByRole("status", { name: "Transcript search matches" }),
  ).toHaveText("1 match");
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(current))
    .toMatchObject({ text: "unique older" });
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.has("transcript-match")))
    .toBe(false);
});

test.describe("touch reading controls", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("code actions are distinct touch targets and narrow search keeps its existing dismiss behavior", async ({
    page,
    context,
  }) => {
    const emit = await openEventSession(
      page,
      "Touch code actions",
      configuration,
      {},
    );
    const code = "console.log('Ready');";
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: `\`\`\`js\n${code}\n\`\`\``,
        timestamp: 1,
      },
    });
    const copy = page.getByRole("button", { name: "Copy code", exact: true });
    await expect(copy).toBeVisible();
    await page.setViewportSize({ width: 320, height: 844 });
    const insert = page.getByRole("button", {
      name: "Insert code in terminal",
    });
    const left = (await insert.boundingBox())!;
    const right = (await copy.boundingBox())!;
    expect(
      Math.min(left.width, left.height, right.width, right.height),
    ).toBeGreaterThanOrEqual(36);
    expect(right.x - left.x - left.width).toBeGreaterThanOrEqual(8);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await copy.tap();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      code,
    );
    await expect(page.locator(".ctx")).toHaveCount(0);
    const log = page.getByRole("log");
    const readingPosition = () =>
      log.evaluate((el) => ({
        top: el.scrollTop,
        width: el.clientWidth,
        height: el.clientHeight,
      }));
    const beforeSearch = await readingPosition();
    const input = await openConversationSearch(page);
    await expect(input).toBeFocused();
    expect(await readingPosition()).toEqual(beforeSearch);
    await input.fill("Ready");
    await input.press("Enter");
    await expect
      .poll(() => page.evaluate(current))
      .toMatchObject({ text: "Ready", code: true });
    const search = page.getByRole("search", { name: "Search conversation" });
    const scope = search.getByRole("combobox", { name: "Search scope" });
    await scope.tap();
    await page.getByRole("option", { name: "User", exact: true }).tap();
    await expect(input).toHaveValue("Ready");
    await expect(page.getByLabel("Transcript search matches")).toHaveText(
      "0 matches",
    );
    expect(
      await search.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    await input.press("Escape");
    await expect(input).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Open conversation search" }),
    ).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => CSS.highlights.has("transcript-match")))
      .toBe(false);
    const createdTerminals: Response[] = [];
    const recordTerminal = (response: Response) => {
      if (
        response.ok() &&
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/terminals"
      )
        createdTerminals.push(response);
    };
    page.on("response", recordTerminal);
    try {
      await insert.tap();
      await expect(
        page.locator(".ctx__terminal-tabs [role=tab][aria-selected=true]"),
      ).toHaveAttribute("aria-selected", "true");
    } finally {
      page.off("response", recordTerminal);
      for (const response of createdTerminals) {
        const { id } = (await response.json()) as { id: string };
        const closed = await hostRequest(page).delete(
          `/api/terminals/${encodeURIComponent(id)}?force=1`,
          { headers: await terminalMutationHeaders(page) },
        );
        expect(closed.ok()).toBe(true);
      }
    }
  });
});
