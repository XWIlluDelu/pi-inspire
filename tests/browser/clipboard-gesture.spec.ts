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
    .getByRole("searchbox", { name: "Find in history" })
    .fill("User source");
  await history
    .getByRole("button", { name: /Your input.*User source/ })
    .click();
  return history;
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
  const mixedBubbles = transcript.locator(".user-bubble").filter({
    has: page.getByRole("list", { name: "Referenced files" }),
  });
  await expect(mixedBubbles).toHaveCount(2);
  await page.setViewportSize({ width: 320, height: 900 });
  for (const bubble of await mixedBubbles.all()) {
    await bubble.scrollIntoViewIfNeeded();
    const image = bubble.getByRole("group", { name: "Attached images" });
    const files = bubble.getByRole("list", { name: "Referenced files" });
    await expect(image.locator("img")).toBeVisible();
    await expect(files).toHaveText("report.md");
    const imageBox = (await image.boundingBox())!;
    expect(imageBox.y + imageBox.height).toBeLessThan(
      (await files.boundingBox())!.y,
    );
  }
  const files = (await mixed
    .getByRole("list", { name: "Referenced files" })
    .boundingBox())!;
  const prose = (await mixed.locator(".rich-text").boundingBox())!;
  expect(files.y + files.height).toBeLessThan(prose.y);
  await expect(mixedBubbles.last().locator(".rich-text")).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });

  const search = await openConversationSearch(page);
  const matches = page.getByLabel("Transcript search matches");
  await search.fill("report.md");
  await expect(matches).toHaveText("3 matches");
  for (const attachment of [true, false, true]) {
    await search.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const range = CSS.highlights
            .get("transcript-current-match")
            ?.values()
            .next().value as Range | undefined;
          const element = range?.startContainer.parentElement;
          if (!element) return null;
          return Boolean(element.closest(".user-bubble__file"));
        }),
      )
      .toBe(attachment);
  }
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
  await expect(transcript).not.toContainText(copyTail);
});

test("starts History Copy at the gesture and delivers complete text and saved PNG without expanding the reader", {
  tag: "@cross-browser",
}, async ({ page, browserName }) => {
  const reading = Promise.withResolvers<void>();
  const delivery = Promise.withResolvers<void>();
  const history = await openHistoryDetail(page);
  const more = history.getByRole("button", { name: "Read more content" });
  await expect(more).toBeVisible();
  await observeWrites(page);
  await page.route(
    "**/api/branches/entry?**",
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
    history.getByRole("button", { name: "Read more content" }),
  ).toBeVisible();
  await observeWrites(page);

  const historyRead = Promise.withResolvers<void>();
  const historyDelivery = Promise.withResolvers<void>();
  await page.route("**/api/branches/entry?**", async (route) => {
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
        new URL(request.url()).pathname === "/api/branches/entry",
    });
    await history
      .getByRole("button", { name: "Back to history", exact: true })
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
