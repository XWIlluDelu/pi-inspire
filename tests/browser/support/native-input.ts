import type { Locator } from "@playwright/test";

/** Native textarea document navigation differs from shell control sequences. */
export async function moveCaretToEnd(input: Locator) {
  await input.press(
    process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
  );
}
