import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// UI/receipt tests start at the authenticated transport boundary. Cryptographic
// protocol/isolation is exercised by browser-auth server and browser-engine tests.
vi.mock("../../src/browser-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/browser-auth")>()),
  authenticatedFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
    transport: typeof fetch = fetch,
  ) => transport(input, init),
  socketTicket: vi.fn(async () => "fixture-socket-ticket"),
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub;

// jsdom has no layout; feedback is in view unless a visibility test overrides it.
class IntersectionObserverStub {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [
        {
          target,
          isIntersecting: true,
          intersectionRatio: 1,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.IntersectionObserver =
  IntersectionObserverStub as unknown as typeof IntersectionObserver;

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

// Each case starts with a fresh browser workbench. Reload tests retain storage
// between mounts inside their own case; unrelated cases must not restore it.
afterEach(() => {
  cleanup();
  for (const key of Object.keys(window.sessionStorage)) {
    if (key.startsWith("inspire:workbench:v1:"))
      window.sessionStorage.removeItem(key);
  }
});
