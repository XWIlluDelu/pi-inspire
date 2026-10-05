import { vi } from "vitest";

/** jsdom has no layout; give the actual virtualizer a bounded scroll viewport. */
export function mockModelMenuLayout() {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("model-picker__list") ? 360 : 0;
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: function (this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
    },
  });
}
