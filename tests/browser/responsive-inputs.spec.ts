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

test("@cross-browser live text-size changes reflow the same draft across layouts", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const draft = "Keep the complete draft while changing text size.\n"
    .repeat(4)
    .trimEnd();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  async function changeSize(name: string) {
    await openSettings(page);
    await settings
      .getByRole("button", { name: "Display", exact: true })
      .click();
    await settings
      .getByRole("group", { name: "Content text size" })
      .getByRole("button", {
        name,
        exact: true,
      })
      .click();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
  }
  await message.fill(draft);
  const heights: number[] = [];
  try {
    for (const [label, size] of [
      ["Compact", "14px"],
      ["Comfortable", "15.5px"],
      ["Large", "17px"],
    ] as const) {
      await changeSize(label);
      await expectTypeAcrossWidths(page, message, size);
      await expect(message).toHaveValue(draft);
      await expect
        .poll(() => message.evaluate((el) => el.scrollHeight - el.clientHeight))
        .toBe(0);
      heights.push((await message.boundingBox())!.height);
    }
    expect(heights.at(-1)!).toBeGreaterThan(heights[0]!);
  } finally {
    await changeSize("Comfortable");
    await message.fill("");
  }
});
