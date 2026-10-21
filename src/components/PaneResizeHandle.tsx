import { useLayoutEffect, useRef, useState } from "react";

interface PaneResizeHandleProps {
  cssVar: string;
  storageKey: string;
  paneSelector: string;
  edge: "start" | "end";
  min: number;
  max: (viewportWidth: number) => number;
  label: string;
  variant: string;
  /** Re-apply preferences when desktop pane membership changes, not on ordinary renders. */
  layoutKey?: string;
  peerPane?: { cssVar: string; paneSelector: string };
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
  return Math.min(max, Math.max(min, value));
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

  const absoluteBounds = (): Pick<ResizeMetrics, "min" | "max"> => ({
    min: props.min,
    max: Math.max(props.min, props.max(window.innerWidth)),
  });

  const bounds = (): Pick<ResizeMetrics, "min" | "max"> => {
    const range = absoluteBounds();
    const center = document.querySelector<HTMLElement>(".app > .center");
    const current = rawSize();
    if (!center || current === null) return range;
    const reserve =
      Number.parseFloat(
        getComputedStyle(center).getPropertyValue("--conversation-min-w"),
      ) || 0;
    return {
      ...range,
      max: Math.max(
        range.min,
        Math.min(
          range.max,
          current + center.getBoundingClientRect().width - reserve,
        ),
      ),
    };
  };

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

  // User resizing owns only this side. Freeze the peer's current rendered width
  // (which may be temporarily clamped), without replacing its saved preference.
  const holdAdjacentPane = () => {
    const pane = paneElement();
    const current = rawSize();
    if (pane && current !== null) {
      setLiveSize(current);
      pane.style.flexShrink = "1";
    }
    if (!props.peerPane) return;
    const peer = document.querySelector<HTMLElement>(
      props.peerPane.paneSelector,
    );
    if (!peer) return;
    document.documentElement.style.setProperty(
      props.peerPane.cssVar,
      `${peer.getBoundingClientRect().width}px`,
    );
    peer.style.flexShrink = "0";
  };

  const applyResponsiveSize = () => {
    // CSS shares insufficient space between the panes while preserving the
    // conversation floor. Restore desired widths, not an order-dependent clamp
    // against the peer's geometry from the previous window size.
    paneElement()?.style.removeProperty("flex-shrink");
    const stored = readStoredSize(props.storageKey);
    if (stored === null) {
      clearLiveSize();
      const natural = rawSize();
      if (natural === null) return;
      const range = absoluteBounds();
      const bounded = clamp(natural, range.min, range.max);
      if (bounded !== natural) setLiveSize(bounded);
    } else {
      const range = absoluteBounds();
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: handle configuration is stable; only pane membership resets the live preference.
  useLayoutEffect(() => {
    applyResponsiveSize();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const measured = measure();
            if (measured)
              setMetrics((previous) =>
                previous.current === measured.current &&
                previous.max === measured.max
                  ? previous
                  : measured,
              );
          });
    const pane = paneElement();
    const center = document.querySelector(".app > .center");
    if (pane) observer?.observe(pane);
    if (center) observer?.observe(center);
    window.addEventListener("resize", applyResponsiveSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", applyResponsiveSize);
      pane?.style.removeProperty("flex-shrink");
      document.body.classList.remove(
        "pane-resizing",
        "pane-resizing--vertical",
      );
    };
  }, [props.layoutKey]);

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
    holdAdjacentPane();
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
          holdAdjacentPane();
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
          const range = bounds();
          const size = clamp(
            active.metrics.current +
              direction * (event.clientX - active.startCoordinate),
            range.min,
            range.max,
          );
          active.size = size;
          setLiveSize(size);
          setMetrics({ ...range, current: size });
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
          holdAdjacentPane();
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
