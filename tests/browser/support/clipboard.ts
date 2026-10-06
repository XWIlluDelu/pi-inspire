import type { Page } from "@playwright/test";

/** Windows exposes native clipboard line endings; compare content, not encoding. */
export async function clipboardLines(page: Page) {
  return (await page.evaluate(() => navigator.clipboard.readText())).split(
    /\r?\n/,
  );
}
