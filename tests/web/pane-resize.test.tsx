// @vitest-environment jsdom
import {
  act,
  createEvent,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
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
        const hidden = this.classList.contains("wheel-target--hidden");
        const width = hidden
          ? 0
          : this.classList.contains("ctx")
            ? Number.parseFloat(
                document.documentElement.style.getPropertyValue("--ctx-w"),
              ) || 500
            : 500;
        const height = hidden
          ? 0
          : this.classList.contains("split-primary")
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

  it("forwards normalized wheel input without swallowing zoom or boundary gestures", async () => {
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
            storageKey="inspire.resources-wheel"
            min={96}
            minRemainder={160}
            label="Resize file list and preview"
            variant="resources"
            wheelTargetSelector=".wheel-target[data-pane-scroll-active='true']"
          />
          <div
            className="wheel-target wheel-target--hidden"
            data-pane-scroll-active="true"
          />
          <div className="wheel-target" data-pane-scroll-active="true" />
        </div>
      );
    }
    const view = render(<SplitHarness />);
    const target = view.container.querySelector<HTMLElement>(
      ".wheel-target:not(.wheel-target--hidden)",
    )!;
    const hiddenTarget = view.container.querySelector<HTMLElement>(
      ".wheel-target--hidden",
    )!;
    for (const element of [hiddenTarget, target])
      Object.defineProperties(element, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 1_000 },
        clientWidth: { configurable: true, value: 100 },
        scrollWidth: { configurable: true, value: 100 },
      });
    const handle = view.getByRole("separator", {
      name: "Resize file list and preview",
    });

    const lineWheel = createEvent.wheel(handle, {
      clientY: 50,
      deltaY: 3,
      deltaMode: 1,
      cancelable: true,
    });
    const preventLineWheel = vi.spyOn(lineWheel, "preventDefault");
    fireEvent(handle, lineWheel);
    expect(target.scrollTop).toBe(48);
    expect(hiddenTarget.scrollTop).toBe(0);
    expect(preventLineWheel).toHaveBeenCalledOnce();

    const zoomWheel = createEvent.wheel(handle, {
      clientY: 50,
      deltaY: 100,
      ctrlKey: true,
      cancelable: true,
    });
    const preventZoomWheel = vi.spyOn(zoomWheel, "preventDefault");
    fireEvent(handle, zoomWheel);
    expect(preventZoomWheel).not.toHaveBeenCalled();
    expect(target.scrollTop).toBe(48);

    target.scrollTop = 900;
    const boundaryWheel = createEvent.wheel(handle, {
      clientY: 50,
      deltaY: 1,
      cancelable: true,
    });
    const preventBoundaryWheel = vi.spyOn(boundaryWheel, "preventDefault");
    fireEvent(handle, boundaryWheel);
    expect(preventBoundaryWheel).not.toHaveBeenCalled();
    expect(target.scrollTop).toBe(900);
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
