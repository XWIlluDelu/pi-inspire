import { useEffect, useRef, useState } from "react";

interface PaneResizeHandleProps {
  cssVar: string;
  storageKey: string;
  paneSelector: string;
  edge: "start" | "end";
  min: number;
  max: (viewportWidth: number) => number;
  label: string;
  variant: string;
  /** Active native scroller(s) inside the adjacent pane. Wheel input over the
   * resize hit band is forwarded to the target under the pointer. */
  wheelTargetSelector?: string;
}

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
const WHEEL_LINE_PX = 16;

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

/** Resizes one outer workbench boundary with pointer, keyboard, persistence,
 * responsive clamping, and double-click reset. */
export function PaneResizeHandle(props: PaneResizeHandleProps) {
  const dragRef = useRef<ActiveDrag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [metrics, setMetrics] = useState<ResizeMetrics>({
    current: props.min,
    min: props.min,
    max: props.min,
  });

  const paneElement = (): HTMLElement | null =>
    document.querySelector(props.paneSelector);

  const rawSize = (): number | null => {
    const pane = paneElement();
    return pane ? pane.getBoundingClientRect().width : null;
  };

  const bounds = (): Pick<ResizeMetrics, "min" | "max"> => ({
    min: props.min,
    max: Math.max(props.min, props.max(window.innerWidth)),
  });

  const measure = (): ResizeMetrics | null => {
    const current = rawSize();
    if (current === null) return null;
    const range = bounds();
    return { current: clamp(current, range.min, range.max), ...range };
  };

  const setLiveSize = (size: number) => {
    document.documentElement.style.setProperty(props.cssVar, `${size}px`);
  };

  const clearLiveSize = () => {
    document.documentElement.style.removeProperty(props.cssVar);
  };

  const applyResponsiveSize = () => {
    const stored = readStoredSize(props.storageKey);
    if (stored === null) {
      clearLiveSize();
      const natural = rawSize();
      if (natural === null) return;
      const range = bounds();
      const bounded = clamp(natural, range.min, range.max);
      if (bounded !== Math.round(natural)) setLiveSize(bounded);
    } else {
      const range = bounds();
      setLiveSize(clamp(stored, range.min, range.max));
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: both call sites provide mount-time handle configuration.
  useEffect(() => {
    applyResponsiveSize();
    window.addEventListener("resize", applyResponsiveSize);
    return () => {
      window.removeEventListener("resize", applyResponsiveSize);
      document.body.classList.remove(
        "pane-resizing",
        "pane-resizing--vertical",
      );
    };
  }, []);

  const finishDrag = (target: HTMLDivElement, pointerId: number) => {
    const active = dragRef.current;
    if (!active) return;
    dragRef.current = null;
    commit(active.size);
    if (target.hasPointerCapture(pointerId))
      target.releasePointerCapture(pointerId);
    setDragging(false);
    document.body.classList.remove("pane-resizing", "pane-resizing--vertical");
  };

  const reset = () => {
    writeStoredSize(props.storageKey, null);
    clearLiveSize();
    applyResponsiveSize();
  };

  const forwardWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!props.wheelTargetSelector || event.ctrlKey) return;
    const targets = [
      ...document.querySelectorAll<HTMLElement>(props.wheelTargetSelector),
    ].filter((target) => {
      const rect = target.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        (target.scrollHeight > target.clientHeight ||
          target.scrollWidth > target.clientWidth)
      );
    });
    const target =
      targets.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return event.clientY >= rect.top && event.clientY <= rect.bottom;
      }) ?? targets[0];
    if (!target) return;
    const lineScale = event.deltaMode === 1 ? WHEEL_LINE_PX : 1;
    const verticalScale =
      event.deltaMode === 2 ? target.clientHeight : lineScale;
    const horizontalScale =
      event.deltaMode === 2 ? target.clientWidth : lineScale;
    const nextTop = Math.min(
      Math.max(0, target.scrollHeight - target.clientHeight),
      Math.max(0, target.scrollTop + event.deltaY * verticalScale),
    );
    const nextLeft = Math.min(
      Math.max(0, target.scrollWidth - target.clientWidth),
      Math.max(0, target.scrollLeft + event.deltaX * horizontalScale),
    );
    if (nextTop === target.scrollTop && nextLeft === target.scrollLeft) return;
    target.scrollTop = nextTop;
    target.scrollLeft = nextLeft;
    event.preventDefault();
  };

  const direction = props.edge === "end" ? 1 : -1;
  return (
    <div
      className={`pane-resize pane-resize--vertical pane-resize--${props.variant}`}
    >
      <div
        className={`pane-resize__hit ${dragging ? "pane-resize__hit--drag" : ""}`}
        role="separator"
        aria-orientation="vertical"
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
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            startCoordinate: event.clientX,
            metrics: measured,
            size: measured.current,
          };
          setMetrics(measured);
          setDragging(true);
          document.body.classList.add(
            "pane-resizing",
            "pane-resizing--vertical",
          );
        }}
        onPointerMove={(event) => {
          const active = dragRef.current;
          if (!active) return;
          const size = clamp(
            active.metrics.current +
              direction * (event.clientX - active.startCoordinate),
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
        onWheel={forwardWheel}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const measured = measure();
          if (!measured) return;
          event.preventDefault();
          const coordinateDelta =
            event.key === "ArrowRight" ? KEYBOARD_STEP : -KEYBOARD_STEP;
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
