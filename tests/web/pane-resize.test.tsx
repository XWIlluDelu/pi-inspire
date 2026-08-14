// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

describe("PaneResizeHandle responsive bounds", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, String(value)),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
    document.documentElement.style.removeProperty("--ctx-w");
    setViewport(1_600);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width = this.classList.contains("ctx")
          ? Number.parseFloat(
              document.documentElement.style.getPropertyValue("--ctx-w"),
            ) || 500
          : 0;
        return {
          x: 0,
          y: 0,
          top: 0,
          right: width,
          bottom: 800,
          left: 0,
          width,
          height: 800,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    document.documentElement.style.removeProperty("--ctx-w");
  });

  it("temporarily clamps a saved pane width when the window narrows and restores it when expanded", async () => {
    window.localStorage.setItem("inspire.ctx-width", "700");
    const { PaneResizeHandle } = await import(
      "../../src/components/PaneResizeHandle"
    );
    render(
      <>
        <aside className="ctx" />
        <PaneResizeHandle
          cssVar="--ctx-w"
          storageKey="inspire.ctx-width"
          paneSelector=".ctx"
          edge="start"
          min={320}
          max={(viewport) => Math.min(920, viewport - 640)}
          label="Resize files panel"
          variant="ctx"
        />
      </>,
    );

    expect(document.documentElement.style.getPropertyValue("--ctx-w")).toBe(
      "700px",
    );

    act(() => {
      setViewport(980);
      window.dispatchEvent(new Event("resize"));
    });
    expect(document.documentElement.style.getPropertyValue("--ctx-w")).toBe(
      "340px",
    );
    expect(window.localStorage.getItem("inspire.ctx-width")).toBe("700");

    act(() => {
      setViewport(1_600);
      window.dispatchEvent(new Event("resize"));
    });
    expect(document.documentElement.style.getPropertyValue("--ctx-w")).toBe(
      "700px",
    );
  });
});
