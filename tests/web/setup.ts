import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Shared setup for both environments: node (server tests) and jsdom (web
// tests, opted in per file via `// @vitest-environment jsdom`). All guards
// below tolerate the absence of a DOM.

if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (typeof window !== "undefined") {
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  HTMLElement.prototype.hasPointerCapture ??= () => false;
  globalThis.CSS ??= {} as typeof CSS;
  CSS.escape ??= (value) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

// Fetch/WebSocket stubs are installed per test file (beforeAll) or per test
// (beforeEach); vitest isolates files, so globals must NOT be unstubbed
// between tests of the same file.
afterEach(() => {
  cleanup();
});
