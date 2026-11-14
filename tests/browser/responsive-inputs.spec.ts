import { expect, test } from "@playwright/test";
import {
  openFixtureSession,
  openSettings,
  pairedPage,
} from "./support/navigation";

test.use({
  serviceWorkers: "block",
  viewport: { width: 1280, height: 900 },
  contextOptions: { reducedMotion: "reduce" },
});

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
      .getByRole("combobox", { name: "Content text size", exact: true })
      .selectOption({ label: name });
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
  }
  await message.fill(draft);
  try {
    await changeSize("Compact");
    const height = (await message.boundingBox())!.height;
    await page.setViewportSize({ width: 390, height: 900 });
    await changeSize("Large");
    await expect(message).toHaveValue(draft);
    await expect(message).toHaveCSS("font-size", "17px");
    expect((await message.boundingBox())!.height).toBeGreaterThan(height);
  } finally {
    await changeSize("Comfortable");
    await message.fill("");
  }
});
