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

test("copies complete saved messages and images from bounded conversation previews", async ({
  page,
}) => {
  // Copy reads are scoped to a projection. Wait for the saved preview to be
  // replaced by the warm Pi worker before exercising a multi-page copy.
  const ready = page.waitForResponse((response) =>
    response.ok() && new URL(response.url()).searchParams.get("detail") === COPY_FIXTURE_SESSION_ID,
  );
  await openSavedCopy(page);
  const { active } = await (await ready).json();
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
  const fork = mixed.getByRole("button", {
    name: "Fork session from this input",
  });
  await messageCopy.press("Tab");
  await expect(fork).toBeFocused();
  await expect(transcript).not.toContainText(copyTail);

  await openFixtureSession(page, /Compaction checkpoint fixture/);
  await page.setViewportSize({ width: 320, height: 844 });
  const checkpoint = page.locator(".context-checkpoint");
  const disclosure = checkpoint.getByRole("button", {
    name: "Context compacted",
    exact: true,
  });
  await disclosure.press("Enter");
  await disclosure.press("Tab");
  const copy = checkpoint.getByRole("button", {
    name: "Copy compaction summary",
  });
  await expect(copy).toBeFocused();
  await copy.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.gestureClipboardWrites.at(-1)))
    .toEqual({
      text: "## Preserved context\n\nKeep the parser decisions and remaining work.",
      imageWidth: null,
    });
});
