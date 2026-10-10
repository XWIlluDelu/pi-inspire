import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub;

window.matchMedia = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});

URL.createObjectURL = () => "blob:test";
URL.revokeObjectURL = () => {};
Element.prototype.scrollIntoView = () => {};
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value(this: HTMLElement, options: ScrollToOptions = {}) {
    this.scrollTop = options.top ?? this.scrollTop;
    this.scrollLeft = options.left ?? this.scrollLeft;
  },
});
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.releasePointerCapture = () => {};
HTMLElement.prototype.hasPointerCapture = () => false;
globalThis.CSS = {
  escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&"),
} as typeof CSS;

// Each file owns its Fetch/WebSocket stubs; cleanup only mounted React trees.
afterEach(cleanup);
