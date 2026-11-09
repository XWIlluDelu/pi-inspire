import { expect, type Locator } from "@playwright/test";

export async function expectConfigurationField(field: Locator) {
  await expect(field).toBeFocused();
  await expect
    .poll(() =>
      field.evaluate((input) => {
        const body = input.closest(".models-form__body")!;
        const main = input.closest(".settings__content")!;
        const label = input.closest("label, .models-form__field")!;
        const caption = document.createRange();
        caption.selectNode(label.firstChild!);
        const control = input.getBoundingClientRect();
        const text = caption.getBoundingClientRect();
        const scrollport = main.getBoundingClientRect();
        const content = body.getBoundingClientRect();
        const actions = input
          .closest("form")!
          .querySelector(".models-form__actions")!
          .getBoundingClientRect();
        const top = Math.max(scrollport.top, content.top);
        const bottom = Math.min(scrollport.bottom, content.bottom, actions.top);
        return Math.min(
          text.top - top,
          control.top - top,
          bottom - control.bottom,
        );
      }),
    )
    .toBeGreaterThanOrEqual(-0.5);
  const actions = field
    .locator("xpath=ancestor::form")
    .locator(".models-form__actions");
  await expect(
    actions.getByRole("button", { name: "Save", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    actions.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeInViewport({ ratio: 1 });
}
