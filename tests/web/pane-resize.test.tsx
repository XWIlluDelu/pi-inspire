// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

describe("Pane resize handles", () => {
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
          : 500;
        const height = this.classList.contains("split-primary")
          ? Number.parseFloat(
              this.parentElement?.style.getPropertyValue(
                "--pane-resize-primary-size",
              ) ?? "",
            ) || 240
          : this.classList.contains("split-container")
            ? 600
            : 800;
        return {
          x: 0,
          y: 0,
          top: 0,
          right: width,
          bottom: height,
          left: 0,
          width,
          height,
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

  it("drags the horizontal boundary, supports the keyboard, and restores its saved size", async () => {
    window.localStorage.setItem("inspire.resources-split", "300");
    const { PaneResizeHandle } = await import(
      "../../src/components/PaneResizeHandle"
    );
    function SplitHarness() {
      const containerRef = useRef<HTMLDivElement>(null);
      const primaryRef = useRef<HTMLDivElement>(null);
      return (
        <div className="split-container" ref={containerRef}>
          <div className="split-primary" ref={primaryRef} />
          <PaneResizeHandle
            orientation="horizontal"
            container={containerRef}
            pane={primaryRef}
            cssVar="--pane-resize-primary-size"
            storageKey="inspire.resources-split"
            min={96}
            minRemainder={160}
            label="Resize file list and preview"
            variant="resources"
          />
          <div />
        </div>
      );
    }
    const view = render(<SplitHarness />);
    const split =
      view.container.querySelector<HTMLElement>(".split-container")!;
    const handle = view.getByRole("separator", {
      name: "Resize file list and preview",
    });

    await waitFor(() =>
      expect(split.style.getPropertyValue("--pane-resize-primary-size")).toBe(
        "300px",
      ),
    );
    expect(handle).toHaveAttribute("aria-orientation", "horizontal");

    fireEvent.pointerDown(handle, { button: 0, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 400, pointerId: 1 });
    expect(split.style.getPropertyValue("--pane-resize-primary-size")).toBe(
      "400px",
    );
    expect(window.localStorage.getItem("inspire.resources-split")).toBe("400");

    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(split.style.getPropertyValue("--pane-resize-primary-size")).toBe(
      "376px",
    );
    fireEvent.doubleClick(handle);
    expect(split.style.getPropertyValue("--pane-resize-primary-size")).toBe("");
    expect(split).not.toHaveAttribute("data-pane-resize-sized");
    expect(window.localStorage.getItem("inspire.resources-split")).toBeNull();
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
