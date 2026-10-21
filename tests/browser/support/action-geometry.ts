import type { Locator } from "@playwright/test";

/** Compare action positions as well as widths: adjacent buttons should not jump. */
export function actionGeometry(row: Locator) {
  return row.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}
