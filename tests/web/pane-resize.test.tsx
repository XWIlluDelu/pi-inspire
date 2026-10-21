// @vitest-environment jsdom
import {
  act,
  createEvent,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneResizeHandle } from "../../src/components/PaneResizeHandle";

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
        const height = hidden ? 0 : 800;
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

  it("drags, keyboard-resizes, persists, and resets an outer boundary", async () => {
    window.localStorage.setItem("inspire.ctx-width", "600");
    const view = render(
      <>
        <aside className="ctx" />
        <PaneResizeHandle
          cssVar="--ctx-w"
          storageKey="inspire.ctx-width"
          paneSelector=".ctx"
          edge="start"
          min={320}
          max={() => 920}
          label="Resize files panel"
          variant="ctx"
        />
      </>,
    );
    const handle = view.getByRole("separator", {
      name: "Resize files panel",
    });

    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--ctx-w")).toBe(
        "600px",
      ),
    );
    expect(handle).toHaveAttribute("aria-orientation", "vertical");

    fireEvent.pointerDown(handle, { button: 0, clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 500, pointerId: 1 });
    expect(document.documentElement.style.getPropertyValue("--ctx-w")).toBe(
      "700px",
    );
    expect(window.localStorage.getItem("inspire.ctx-width")).toBe("700");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(document.documentElement.style.getPropertyValue("--ctx-w")).toBe(
      "676px",
    );
    fireEvent.doubleClick(handle);
    expect(document.documentElement.style.getPropertyValue("--ctx-w")).toBe("");
    expect(window.localStorage.getItem("inspire.ctx-width")).toBeNull();
  });

  it("forwards normalized wheel input without swallowing zoom or boundary gestures", () => {
    const view = render(
      <>
        <aside className="ctx" />
        <PaneResizeHandle
          cssVar="--ctx-w"
          storageKey="inspire.ctx-wheel"
          paneSelector=".ctx"
          edge="start"
          min={320}
          max={() => 920}
          label="Resize files panel"
          variant="ctx"
          wheelTargetSelector=".wheel-target[data-pane-scroll-active='true']"
        />
        <div
          className="wheel-target wheel-target--hidden"
          data-pane-scroll-active="true"
        />
        <div className="wheel-target" data-pane-scroll-active="true" />
      </>,
    );
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
      name: "Resize files panel",
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
    fireEvent(handle, zoomWheel);
    expect(zoomWheel.defaultPrevented).toBe(false);
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

  it("temporarily clamps a saved pane width when the window narrows and restores it when expanded", () => {
    window.localStorage.setItem("inspire.ctx-width", "700");
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
