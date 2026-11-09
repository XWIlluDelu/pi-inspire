import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  openCommandPalette,
  openConversationSearch,
  openFixtureSession,
  openSettings,
  pairedPage,
} from "./support/navigation";

test.use({
  serviceWorkers: "block",
  viewport: { width: 1280, height: 900 },
  contextOptions: { reducedMotion: "reduce" },
});

async function expectInputType(input: Locator, fontSize: string) {
  await expect(input).toBeInViewport();
  await expect(input).toHaveCSS("font-size", fontSize);
  await input.focus();
  await expect(input).toBeFocused();
  await expect(input).toHaveCSS("font-size", fontSize);
}

async function expectTypeAcrossWidths(
  page: Page,
  input: Locator,
  fontSize: string,
) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expectInputType(input, fontSize);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

for (const width of [1280, 390]) {
  test(`@cross-browser path and search inputs retain their owner typography at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await pairedPage(page);
    await expectInputType(
      page.getByRole("textbox", { name: "Project directory", exact: true }),
      "12.5px",
    );

    const palette = await openCommandPalette(page);
    await expectInputType(palette.getByLabel("Filter commands"), "14px");
    await page.keyboard.press("Escape");

    await openFixtureSession(page, /Review extension event lifecycle/);
    const conversationSearch = await openConversationSearch(page);
    await expectInputType(conversationSearch, "12.5px");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Model", exact: true }).click();
    await expectInputType(
      page.locator(".model-picker__menu").getByRole("combobox", {
        name: "Search models",
        exact: true,
      }),
      "12.5px",
    );
    await page.keyboard.press("Escape");

    await page
      .getByRole("button", { name: "Add project files", exact: true })
      .click();
    await expectInputType(
      page
        .getByRole("dialog", { name: "Add project files", exact: true })
        .getByRole("combobox", { name: "Search project files", exact: true }),
      "12.5px",
    );
    await page.keyboard.press("Escape");
  });
}

test("@cross-browser message input honors every content size across responsive layouts", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Keep this comparison draft while changing text size.");
  for (const [label, value, size] of [
    ["Compact", "compact", "14px"],
    ["Comfortable", "comfortable", "15.5px"],
    ["Large", "large", "17px"],
  ] as const) {
    await openSettings(page);
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await settings
      .getByRole("group", { name: "Content text size", exact: true })
      .getByRole("button", { name: label, exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-content-text-size",
      value,
    );
    await page.keyboard.press("Escape");
    await expectTypeAcrossWidths(page, message, size);
    await expect(message).toHaveValue(
      "Keep this comparison draft while changing text size.",
    );
  }
});
