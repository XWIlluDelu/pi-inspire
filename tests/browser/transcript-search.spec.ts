import { expect, type Page, test } from "@playwright/test";
import { checkpointAdapterConfiguration } from "../web/fixtures/extension-adapters";
import { clipboardLines } from "./support/clipboard";
import { openEventSession } from "./support/host-events";
import {
  openCommandPalette,
  openConversationSearch,
} from "./support/navigation";
import { terminalOperation } from "./support/terminal-operations";

const searchFixture = (page: Page, name: string) =>
  openEventSession(page, name, checkpointAdapterConfiguration, {});

const highlightCount = (page: Page) =>
  page.evaluate(() => CSS.highlights.get("transcript-match")?.size ?? 0);
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

test("@cross-browser search keeps tab order, wraps matches, and yields composing keys", async ({
  page,
}) => {
  const emit = await searchFixture(page, "Composition-owned search");
  emit({
    type: "message_end",
    message: { role: "user", content: "测量一，测量二。", timestamp: 1 },
  });
  const input = await openConversationSearch(page);
  const search = page.getByRole("search", { name: "Search conversation" });
  const result = search.getByLabel("Transcript search matches");
  const before = await search.boundingBox();
  await input.fill("测量");
  await expect(result).toHaveText("2 matches");
  expect(await search.boundingBox()).toEqual(before);
  for (const control of [
    search.getByRole("combobox", { name: "Search scope" }),
    search.getByRole("button", { name: "Previous transcript match" }),
    search.getByRole("button", { name: "Next transcript match" }),
  ]) {
    await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(result).toHaveText("1 of 2");
  await input.focus();
  for (const ime of [{ isComposing: true }, { keyCode: 229 }])
    for (const key of ["Enter", "Escape"])
      await input.dispatchEvent("keydown", { key, ...ime });
  await expect(input).toBeFocused();
  await expect(result).toHaveText("1 of 2");
  await input.press("Enter");
  await expect(result).toHaveText("2 of 2");
  await input.press("Enter");
  await expect(result).toHaveText("1 of 2");
  await input.press("Escape");
  await expect(input).not.toBeFocused();
  await expect(input).toHaveValue("测量");
  const palette = await openCommandPalette(page);
  await page.keyboard.press("Control+f");
  await expect(palette).toBeVisible();
  await expect(input).not.toBeFocused();
  await page.keyboard.press("Escape");
  await search
    .getByRole("combobox", { name: "Search scope" })
    .press("Control+f");
  await expect(input).toBeFocused();
  const desktop = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: desktop.height });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("测量");
  await page.setViewportSize(desktop);
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("测量");
});

test("Live highlights rendered text and reveals matched branches, checkpoints and errors", async ({
  page,
}) => {
  const emit = await searchFixture(page, "Search highlights");
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
        timestamp: 2,
      },
    },
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
  await input.fill("31m");
  await expect(count).toHaveText("0 matches");
  for (const query of ["Visible status", "Reason for the fork"]) {
    await input.fill(query);
    await input.press("Enter");
    await expect
      .poll(() => page.evaluate(current))
      .toMatchObject({ text: query });
  }
  const branch = page.getByRole("button", { name: "Branch context" });
  await expect(branch).toHaveAttribute("aria-expanded", "true");
  await branch.click();
  await input.press("Enter");
  await expect(branch).toHaveAttribute("aria-expanded", "true");
  await input.fill("PRECISE MATCH");
  await expect(count).toHaveText("6 matches");
  await expect.poll(() => highlightCount(page)).toBe(4);
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
  await expect.poll(() => highlightCount(page)).toBe(1);
  await expect.poll(() => page.evaluate(current)).toBeNull();

  await input.fill("newly settled phrase");
  await page.getByRole("button", { name: "Jump to latest" }).click();
  const live = {
    role: "assistant",
    content: "Newly settled phrase",
    timestamp: 8,
    __inspireLiveId: "search-result-arrival",
  };
  emit(
    { type: "agent_start" },
    { type: "message_start", message: { ...live, content: "" } },
  );
  await expect(
    page.getByRole("status").filter({ hasText: "Working…" }),
  ).toBeVisible();
  emit({ type: "message_update", message: live });
  await expect(page.getByText("Newly settled phrase")).toBeVisible();
  await expect(count).toHaveText("0 matches");
  const scroll = () => page.getByRole("log").evaluate((el) => el.scrollTop);
  const before = await scroll();
  emit({
    type: "message_update",
    message: {
      ...live,
      content: live.content + "\n\n" + "Another paragraph.\n\n".repeat(40),
    },
  });
  await expect.poll(scroll).toBeGreaterThan(before);
  emit({ type: "message_end", message: { ...live, __inspireSettled: true } });
  await expect(count).toHaveText("1 match");
  // An explicitly selected hit wins even if a layout scroll first reaches the tail.
  await input.fill("Reason for the fork");
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(current))
    .toMatchObject({ text: "Reason for the fork" });
  const log = page.getByRole("log");
  await log.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const pinned = await scroll();
  const awayFromLatest = () =>
    log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  emit({
    type: "message_start",
    message: {
      ...live,
      __inspireLiveId: "next-live",
      timestamp: 9,
      content: "Later output.\n\n".repeat(50),
    },
  });
  await expect(log).toContainText("Later output");
  await expect(count).toHaveText("1 of 1");
  expect(await scroll()).toBeCloseTo(pinned, 0);
  expect(await awayFromLatest()).toBeGreaterThan(10);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect.poll(() => highlightCount(page)).toBe(0);
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
    const emit = await searchFixture(page, "Touch code actions");
    const code = "  console.log('Ready');\n\n\t// Preserve indentation";
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
    await expect.poll(() => clipboardLines(page)).toEqual(code.split("\n"));
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
    await scope.click();
    await page
      .getByRole("listbox", { name: "Search scope" })
      .getByRole("option", { name: "User", exact: true })
      .click();
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
    await expect.poll(() => highlightCount(page)).toBe(0);
    const created = page.waitForResponse(
      (response) =>
        response.ok() &&
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/terminal-operations" &&
        response.request().postDataJSON()?.intent?.command === "create",
    );
    await insert.tap();
    const {
      result: { id },
    } = await (await created).json();
    try {
      await expect(
        page.locator(`[role=tab][data-dock-tab="terminal:${id}"]`),
      ).toHaveAttribute("aria-selected", "true");
    } finally {
      const closed = await terminalOperation(page, {
        command: "remove",
        params: { id, force: true },
      });
      expect(closed.ok()).toBe(true);
    }
  });
});
