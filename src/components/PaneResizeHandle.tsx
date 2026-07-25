import { useEffect, useState } from "react";

// localStorage is absent in the jsdom test environment.
const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined =
  typeof window !== "undefined" ? window.localStorage : undefined;

interface PaneResizeHandleProps {
  /** Root-level width variable this handle drives (e.g. "--nav-w"). */
  cssVar: string;
  storageKey: string;
  /** Selector for the pane being resized (used to read the live width). */
  paneSelector: string;
  /** Which edge of the pane the handle rides: "end" = the pane's right edge
   * (nav), "start" = the pane's left edge (ctx). Decides the drag sign. */
  edge: "start" | "end";
  min: number;
  /** Upper bound for a given viewport width. */
  max: (viewportWidth: number) => number;
  label: string;
  /** Modifier for breakpoint-specific hiding (pane-resize--<variant>). */
  variant: string;
}

/** Zero-layout-width pane-resize handle straddling a pane boundary (±4px hit
 * band). Renders beside the pane it resizes; the boundary's scroll-rail thumb
 * sits above it in z-order, so scrolling wins inside the thumb and resizing
 * wins along the rest of the edge. Double-click restores the default width;
 * arrow keys resize from the keyboard. */
export function PaneResizeHandle({ cssVar, storageKey, paneSelector, edge, min, max, label, variant }: PaneResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  // Exposed as aria-valuenow (a focusable separator is a widget and must
  // report its position); refreshed whenever this handle changes the width.
  const [current, setCurrent] = useState(min);

  const clamp = (width: number) =>
    Math.round(Math.min(Math.max(min, max(window.innerWidth)), Math.max(min, width)));

  const setWidth = (width: number | null) => {
    const root = document.documentElement;
    if (width === null) {
      root.style.removeProperty(cssVar);
      storage?.removeItem(storageKey);
    } else {
      root.style.setProperty(cssVar, `${width}px`);
      storage?.setItem(storageKey, String(width));
    }
  };

  useEffect(() => {
    const stored = Number(storage?.getItem(storageKey));
    if (Number.isFinite(stored) && stored > 0) {
      document.documentElement.style.setProperty(cssVar, `${clamp(stored)}px`);
    }
    setCurrent(Math.round(document.querySelector(paneSelector)?.getBoundingClientRect().width ?? min));
    // Applying the persisted width happens once per handle instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paneWidth = () => document.querySelector(paneSelector)?.getBoundingClientRect().width ?? 0;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = paneWidth();
    if (!startWidth) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    document.body.classList.add("pane-resizing");
    const sign = edge === "end" ? 1 : -1;
    let width = startWidth;
    const onMove = (move: PointerEvent) => {
      width = clamp(startWidth + sign * (move.clientX - startX));
      document.documentElement.style.setProperty(cssVar, `${width}px`);
    };
    const onUp = () => {
      setWidth(width);
      setCurrent(width);
      setDragging(false);
      document.body.classList.remove("pane-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const grows = event.key === (edge === "end" ? "ArrowRight" : "ArrowLeft");
    const next = clamp(paneWidth() + (grows ? 24 : -24));
    setWidth(next);
    setCurrent(next);
  };

  const resetWidth = () => {
    setWidth(null);
    setCurrent(Math.round(paneWidth()));
  };

  return (
    <div className={`pane-resize pane-resize--${variant}`}>
      <div
        className={`pane-resize__hit ${dragging ? "pane-resize__hit--drag" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={current}
        aria-valuemin={min}
        tabIndex={0}
        title="Drag to resize — double-click to reset"
        onPointerDown={onPointerDown}
        onDoubleClick={resetWidth}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
