import { expect, type Page, test } from "@playwright/test";
import { openFixtureSession, pairedPage } from "./support/navigation";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });

async function chooseSource(page: Page) {
  await openFixtureSession(
    page,
    /Calibration history fixture/,
    "fixture-calibration-history",
  );
}

async function connectCalibration(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await chooseSource(page);
}

test("switches branches directly from the title menu and keeps the draft", async ({
  page,
}) => {
  await connectCalibration(page);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep the unsent draft");
  await page.getByRole("button", { name: /^Session actions:/ }).click();
  await page.getByRole("menuitem", { name: "Switch branch…" }).click();
  await page.getByRole("menuitem", { name: /alternate calibration/i }).click();
  await expect(page.getByRole("log")).toContainText(
    "amber reference is retained",
  );
  await expect(composer).toHaveValue("Keep the unsent draft");
});

test("Fork restores saved images for preview, editing and explicit resend", async ({
  page,
}) => {
  await connectCalibration(page);
  const composer = page.getByRole("form", { name: "Message composer" });
  const input = composer.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  await input.fill("Keep this source draft");
  const transcript = page.getByRole("log");
  const turn = transcript.locator(".turn--user").filter({
    hasText: "Compare the calibration strategies",
  });
  await page.getByRole("button", { name: "Open prompt map" }).focus();
  const prompts = page.getByRole("list", { name: "User prompts" });
  await prompts.press("Home");
  await prompts
    .getByRole("button", { name: /Compare the calibration strategies/ })
    .press("Enter");
  await expect(turn).toBeInViewport();
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/branches/fork",
  );
  await turn.hover();
  await turn.getByRole("button", { name: /fork/i }).click();
  const forked = await (await response).json();
  expect(forked.editorAttachments).toHaveLength(1);
  expect(forked.editorText).toContain("Compare the calibration strategies");
  await expect(input).toHaveValue(forked.editorText);
  const restored = composer.locator(".image-preview--attachment");
  await expect(restored).toHaveCount(1);
  await expect(restored.locator("img")).toHaveJSProperty("naturalWidth", 720);
  await input.clear();

  const prompt = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/prompt",
  );
  await composer
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  expect((await prompt).postDataJSON()).toMatchObject({
    sessionId: forked.sessionId,
    message: "",
    attachmentIds: [forked.editorAttachments[0].id],
  });
  await expect(restored).toHaveCount(0);
  await expect(input).toHaveValue("");
});
