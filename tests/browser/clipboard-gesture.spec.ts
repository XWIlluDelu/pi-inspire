import { expect, type Page, test } from "@playwright/test";
import {
  COPY_FIXTURE_SESSION_ID,
  mixedCopySource,
  savedCopy,
} from "../fixtures/workbench-sessions";
import { observeClipboardWrites as observeWrites } from "./support/clipboard";
import {
  openConversationSearch,
  openFixtureSession,
  openHistoryPane,
  pairedPage,
} from "./support/navigation";

test.use({
  serviceWorkers: "block",
  contextOptions: { reducedMotion: "reduce" },
  viewport: { width: 1280, height: 900 },
});

test.beforeEach(async ({ browserName, context }) => {
  // Headless Chromium cannot present its clipboard permission prompt.
  // Firefox/WebKit use the actual gesture boundary without a test grant.
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

async function openSavedCopy(page: Page) {
  await pairedPage(page);
  await openFixtureSession(
    page,
    /Copy saved messages/,
    COPY_FIXTURE_SESSION_ID,
  );
}

async function openHistoryDetail(page: Page) {
  await openSavedCopy(page);
  const history = await openHistoryPane(page);
  await history
    .getByRole("searchbox", { name: "Search this branch" })
    .fill("User source");
  await history.getByRole("button", { name: "Search", exact: true }).click();
  await history
    .getByRole("button", { name: /^Turn 1:/ })
    .first()
    .click();
  await history
    .locator("article")
    .first()
    .getByRole("button", { name: "Read full entry" })
    .click();
  return history.getByRole("article").filter({
    has: page.getByRole("button", { name: "Close entry", exact: true }),
  });
}

test("copies complete saved messages and images from bounded conversation previews", async ({
  page,
}) => {
  const opened = page.waitForResponse("**/api/sessions/open");
  await openSavedCopy(page);
  const { active } = await (await opened).json();
  const copyTail = /(?:USER|ASSISTANT|CUSTOM|DETAIL)_COPY_TAIL/u;
  expect(JSON.stringify(active.transcriptPage.messages)).not.toMatch(copyTail);
  await observeWrites(page);
  const transcript = page.getByRole("log");
  const userTurn = (text: string) =>
    transcript.locator(".turn--user").filter({ hasText: text });
  const mixed = userTurn("Inspect mixed attachments");
  await expect(mixed).not.toContainText("Multiply coordinates");
  const search = await openConversationSearch(page);
  const matches = page.getByLabel("Transcript search matches");
  await search.fill("report.md");
  await expect(matches).toHaveText("3 matches");
  await search.press("Enter");
  await search.fill("Multiply coordinates");
  await expect(matches).toHaveText("0 matches");
  await search.press("Escape");
  const cases = [
    {
      scope: userTurn("User source."),
      name: "Copy message",
      text: savedCopy.user,
      imageWidth: 720,
    },
    {
      scope: mixed,
      name: "Copy message",
      text: mixedCopySource,
      imageWidth: 720,
    },
    {
      name: "Copy response",
      text: `${savedCopy.response}\n\n${savedCopy.final}`,
      imageWidth: null,
    },
    {
      name: "Copy copy fixture block",
      text: [
        "Copy fixture",
        "Type: copy_fixture",
        "Content",
        savedCopy.custom,
        "Details",
        JSON.stringify(savedCopy.details, null, 2),
      ].join("\n\n"),
      imageWidth: null,
    },
  ];
  for (const { scope = transcript, name, text, imageWidth } of cases) {
    await scope.getByRole("button", { name, exact: true }).press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.gestureClipboardWrites.at(-1)))
      .toEqual({ text, imageWidth });
  }
  await page.setViewportSize({ width: 320, height: 1000 });
  const messageCopy = mixed.getByRole("button", {
    name: /^(Copy message|Message copied)$/i,
  });
  const fork = mixed.getByRole("button", { name: "Fork session from this input" });
  await messageCopy.press("Tab");
  await expect(fork).toBeFocused();
  await expect(transcript).not.toContainText(copyTail);

  await openFixtureSession(page, /Compaction checkpoint fixture/);
  await page.setViewportSize({ width: 320, height: 844 });
  const checkpoint = page.locator(".context-checkpoint");
  const disclosure = checkpoint.getByRole("button", { name: "Context compacted", exact: true });
  await disclosure.press("Enter");
  await disclosure.press("Tab");
  const copy = checkpoint.getByRole("button", { name: "Copy compaction summary" });
  await expect(copy).toBeFocused();
  await copy.press("Enter");
  await expect.poll(() => page.evaluate(() => window.gestureClipboardWrites.at(-1))).toEqual({
    text: "## Preserved context\n\nKeep the parser decisions and remaining work.",
    imageWidth: null,
  });
});

test("starts History Copy at the gesture and delivers complete text and saved PNG without expanding the reader", {
  tag: "@cross-browser",
}, async ({ page, browserName }) => {
  const reading = Promise.withResolvers<void>();
  const delivery = Promise.withResolvers<void>();
  const history = await openHistoryDetail(page);
  const more = history.getByRole("button", { name: "Next section" });
  await expect(more).toBeVisible();
  await observeWrites(page);
  await page.route(
    "**/api/history?kind=entry&**",
    async (route) => {
      reading.resolve();
      await delivery.promise;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await history
      .getByRole("button", { name: "Copy history entry", exact: true })
      .press("Enter");
    await reading.promise;
    if (browserName !== "chromium")
      expect(
        await page.evaluate(() => window.gestureClipboardWriteStarts),
      ).toBe(1);
    expect(await page.evaluate(() => window.gestureClipboardWrites)).toEqual(
      [],
    );
  } finally {
    delivery.resolve();
  }
  await expect(
    history.getByRole("button", { name: "history entry copied" }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.gestureClipboardWrites)).toEqual([
    { text: savedCopy.user, imageWidth: 720 },
  ]);
  await expect(more).toBeVisible();
  await expect(history).not.toContainText("USER_COPY_TAIL");
});

test("leaving a pending History copy retires it while /copy keeps the replacement gesture", {
  tag: "@cross-browser",
}, async ({ page, browserName }) => {
  const history = await openHistoryDetail(page);
  await expect(
    history.getByRole("button", { name: "Next section" }),
  ).toBeVisible();
  await observeWrites(page);

  const historyRead = Promise.withResolvers<void>();
  const historyDelivery = Promise.withResolvers<void>();
  await page.route("**/api/history?kind=entry&**", async (route) => {
    const response = await route.fetch();
    historyRead.resolve();
    await historyDelivery.promise;
    await route.fulfill({ response });
  });
  const responseRead = Promise.withResolvers<void>();
  const responseDelivery = Promise.withResolvers<void>();
  await page.route(
    "**/api/transcript/assistant-text?**",
    async (route) => {
      responseRead.resolve();
      await responseDelivery.promise;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await history
      .getByRole("button", { name: "Copy history entry", exact: true })
      .click();
    await historyRead.promise;
    const retired = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        new URL(request.url()).pathname === "/api/history" &&
        new URL(request.url()).searchParams.get("kind") === "entry",
    });
    await history
      .getByRole("button", { name: "Close entry", exact: true })
      .click();
    await retired;

    const writesBeforeCopy = await page.evaluate(
      () => window.gestureClipboardWriteStarts,
    );
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("/copy");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await responseRead.promise;
    if (browserName !== "chromium")
      expect(
        await page.evaluate(() => window.gestureClipboardWriteStarts),
      ).toBe(writesBeforeCopy + 1);
    responseDelivery.resolve();
    await expect
      .poll(() => page.evaluate(() => window.gestureClipboardWrites))
      .toEqual([
        {
          text: `${savedCopy.response}
${savedCopy.final}`,
          imageWidth: null,
        },
      ]);
    await expect(input).toHaveValue("");
    historyDelivery.resolve();
    await page.unrouteAll({ behavior: "wait" });
    expect(
      await page.evaluate(() => window.gestureClipboardWrites),
    ).toHaveLength(1);
  } finally {
    historyDelivery.resolve();
    responseDelivery.resolve();
  }
});
