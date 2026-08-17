import { useEffect, useRef, useState } from "react";

interface ResizeHandleCommonProps {
  /** CSS size variable driven by this handle. */
  cssVar: string;
  storageKey: string;
  min: number;
  label: string;
  /** Modifier for breakpoint-specific visibility or local styling. */
  variant: string;
}

interface VerticalPaneResizeHandleProps extends ResizeHandleCommonProps {
  orientation?: "vertical";
  /** Selector for the pane being resized (used to read the live width). */
  paneSelector: string;
  /** Which edge of the pane the handle rides. This decides the drag sign. */
  edge: "start" | "end";
  /** Upper width bound for a given viewport width. */
  max: (viewportWidth: number) => number;
}

interface HorizontalPaneResizeHandleProps extends ResizeHandleCommonProps {
  orientation: "horizontal";
  /** The stacked regions' shared container and its first region. */
  container: React.RefObject<HTMLElement | null>;
  pane: React.RefObject<HTMLElement | null>;
  minRemainder: number;
}

type PaneResizeHandleProps =
  | VerticalPaneResizeHandleProps
  | HorizontalPaneResizeHandleProps;

interface ResizeMetrics {
  current: number;
  min: number;
  max: number;
}

interface ActiveDrag {
  startCoordinate: number;
  metrics: ResizeMetrics;
  size: number;
}

const KEYBOARD_STEP = 24;
const SPLITTER_SIZE = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

function readStoredSize(storageKey: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStoredSize(storageKey: string, value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, String(value));
  } catch {
    // Resizing remains available for this mount when storage is unavailable.
  }
}

/** One resize mechanism for the workbench's outer vertical boundaries and the
 * resource pane's internal horizontal boundary. Both use the same pointer,
 * keyboard, persistence, responsive-clamp, and reset lifecycle. */
export function PaneResizeHandle(props: PaneResizeHandleProps) {
  const orientation = props.orientation ?? "vertical";
  const dragRef = useRef<ActiveDrag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [metrics, setMetrics] = useState<ResizeMetrics>({
    current: props.min,
    min: props.min,
    max: props.min,
  });

  const paneElement = (): HTMLElement | null => {
    if (props.orientation === "horizontal") return props.pane.current;
    return document.querySelector(props.paneSelector);
  };

  const styleTarget = (): HTMLElement | null => {
    if (props.orientation === "horizontal") return props.container.current;
    return document.documentElement;
  };

  const rawSize = (): number | null => {
    const pane = paneElement();
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    return orientation === "vertical" ? rect.width : rect.height;
  };

  const bounds = (current: number): Pick<ResizeMetrics, "min" | "max"> => {
    if (props.orientation !== "horizontal") {
      return {
        min: props.min,
        max: Math.max(props.min, props.max(window.innerWidth)),
      };
    }
    const container = props.container.current;
    const pane = props.pane.current;
    if (!container || !pane) return { min: 0, max: 0 };
    const available = Math.max(
      0,
      Math.round(
        container.getBoundingClientRect().bottom -
          pane.getBoundingClientRect().top -
          SPLITTER_SIZE,
      ),
    );
    const max = Math.max(0, available - props.minRemainder);
    // A naturally short list may begin below the ordinary drag minimum. Its
    // current height is the initial floor, preventing a first-movement jump.
    return { min: Math.min(props.min, Math.round(current), max), max };
  };

  const measure = (): ResizeMetrics | null => {
    const current = rawSize();
    if (current === null) return null;
    const range = bounds(current);
    return {
      current: clamp(current, range.min, range.max),
      ...range,
    };
  };

  const setLiveSize = (size: number) => {
    const target = styleTarget();
    if (!target) return;
    target.style.setProperty(props.cssVar, `${size}px`);
    if (orientation === "horizontal") target.dataset.paneResizeSized = "true";
  };

  const clearLiveSize = () => {
    const target = styleTarget();
    if (!target) return;
    target.style.removeProperty(props.cssVar);
    if (orientation === "horizontal") delete target.dataset.paneResizeSized;
  };

  const horizontalAvailable = (): number | null => {
    if (props.orientation !== "horizontal") return null;
    const container = props.container.current;
    const pane = props.pane.current;
    if (!container || !pane) return null;
    return Math.max(
      0,
      container.getBoundingClientRect().bottom -
        pane.getBoundingClientRect().top -
        SPLITTER_SIZE,
    );
  };

  const applyResponsiveSize = () => {
    const stored = readStoredSize(props.storageKey);
    if (stored === null) {
      clearLiveSize();
      const natural = rawSize();
      if (natural === null) return;
      const range = bounds(natural);
      const bounded = clamp(natural, range.min, range.max);
      if (bounded !== Math.round(natural)) setLiveSize(bounded);
    } else {
      const current = rawSize();
      if (current === null) return;
      const range = bounds(current);
      // Brief builds before this shared implementation stored a ratio for the
      // horizontal split. Read it once as such; the next interaction writes px.
      const available = horizontalAvailable();
      const desired =
        available !== null && stored < 1 ? stored * available : stored;
      setLiveSize(clamp(desired, range.min, range.max));
    }
    const measured = measure();
    if (measured) setMetrics(measured);
  };

  const commit = (size: number) => {
    setLiveSize(size);
    writeStoredSize(props.storageKey, size);
    const measured = measure();
    if (measured) setMetrics({ ...measured, current: size });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: these props define immutable handle ownership; a changed identity remounts the handle.
  useEffect(() => {
    applyResponsiveSize();
    window.addEventListener("resize", applyResponsiveSize);
    const observer =
      props.orientation === "horizontal" &&
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(applyResponsiveSize)
        : null;
    if (props.orientation === "horizontal" && props.container.current)
      observer?.observe(props.container.current);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", applyResponsiveSize);
      document.body.classList.remove(
        "pane-resizing",
        `pane-resizing--${orientation}`,
      );
    };
  }, []);

  const coordinate = (event: { clientX: number; clientY: number }) =>
    orientation === "vertical" ? event.clientX : event.clientY;
  const direction =
    props.orientation === "horizontal" || props.edge === "end" ? 1 : -1;
  const negativeKey = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
  const positiveKey = orientation === "vertical" ? "ArrowRight" : "ArrowDown";

  const finishDrag = (target: HTMLDivElement, pointerId: number) => {
    const active = dragRef.current;
    if (!active) return;
    dragRef.current = null;
    commit(active.size);
    if (target.hasPointerCapture?.(pointerId))
      target.releasePointerCapture(pointerId);
    setDragging(false);
    document.body.classList.remove(
      "pane-resizing",
      `pane-resizing--${orientation}`,
    );
  };

  const reset = () => {
    writeStoredSize(props.storageKey, null);
    clearLiveSize();
    applyResponsiveSize();
  };

  return (
    <div
      className={`pane-resize pane-resize--${orientation} pane-resize--${props.variant}`}
    >
      <div
        className={`pane-resize__hit ${dragging ? "pane-resize__hit--drag" : ""}`}
        role="separator"
        aria-orientation={orientation}
        aria-label={props.label}
        aria-valuenow={metrics.current}
        aria-valuemin={metrics.min}
        aria-valuemax={metrics.max}
        tabIndex={0}
        title="Drag to resize — double-click to reset"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const measured = measure();
          if (!measured || measured.max <= measured.min) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          dragRef.current = {
            startCoordinate: coordinate(event),
            metrics: measured,
            size: measured.current,
          };
          setMetrics(measured);
          setDragging(true);
          document.body.classList.add(
            "pane-resizing",
            `pane-resizing--${orientation}`,
          );
        }}
        onPointerMove={(event) => {
          const active = dragRef.current;
          if (!active) return;
          const size = clamp(
            active.metrics.current +
              direction * (coordinate(event) - active.startCoordinate),
            active.metrics.min,
            active.metrics.max,
          );
          active.size = size;
          setLiveSize(size);
          setMetrics({ ...active.metrics, current: size });
        }}
        onPointerUp={(event) =>
          finishDrag(event.currentTarget, event.pointerId)
        }
        onPointerCancel={(event) =>
          finishDrag(event.currentTarget, event.pointerId)
        }
        onDoubleClick={reset}
        onKeyDown={(event) => {
          if (event.key !== negativeKey && event.key !== positiveKey) return;
          const measured = measure();
          if (!measured) return;
          event.preventDefault();
          const coordinateDelta =
            event.key === positiveKey ? KEYBOARD_STEP : -KEYBOARD_STEP;
          commit(
            clamp(
              measured.current + direction * coordinateDelta,
              measured.min,
              measured.max,
            ),
          );
        }}
      />
    </div>
  );
}
