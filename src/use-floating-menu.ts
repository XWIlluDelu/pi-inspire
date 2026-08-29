import { useLayoutEffect, useState } from "react";

interface FloatingMenuBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FloatingMenuPlacement {
  direction: "up" | "down";
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

export interface FloatingMenuConstraints {
  gap: number;
  horizontalMargin: number;
  verticalMargin: number;
  maxWidth: number;
  maxHeight: number;
}

interface FloatingMenuTarget {
  context: HTMLElement;
  anchor: FloatingMenuBounds;
  preferredWidth?: number;
  observe?: readonly Element[];
}

function samePlacement(
  left: FloatingMenuPlacement | null,
  right: FloatingMenuPlacement,
): boolean {
  return (
    left?.direction === right.direction &&
    left.left === right.left &&
    left.top === right.top &&
    left.bottom === right.bottom &&
    left.width === right.width &&
    left.maxHeight === right.maxHeight
  );
}

function placeFloatingMenu(
  anchor: FloatingMenuBounds,
  bounds: FloatingMenuBounds,
  layoutHeight: number,
  constraints: FloatingMenuConstraints,
  preferredWidth = constraints.maxWidth,
): FloatingMenuPlacement {
  const availableWidth = Math.max(
    0,
    bounds.right - bounds.left - 2 * constraints.horizontalMargin,
  );
  const width = Math.min(
    constraints.maxWidth,
    Math.max(0, preferredWidth),
    availableWidth,
  );
  const minimumLeft = bounds.left + constraints.horizontalMargin;
  const maximumLeft = Math.max(
    minimumLeft,
    bounds.right - constraints.horizontalMargin - width,
  );
  const left = Math.min(Math.max(anchor.left, minimumLeft), maximumLeft);
  const above = Math.max(
    0,
    anchor.top - constraints.gap - bounds.top - constraints.verticalMargin,
  );
  const below = Math.max(
    0,
    bounds.bottom -
      constraints.verticalMargin -
      anchor.bottom -
      constraints.gap,
  );
  const direction = above >= below ? "up" : "down";
  const maxHeight = Math.min(
    constraints.maxHeight,
    direction === "up" ? above : below,
  );

  return {
    direction,
    left: Math.round(left),
    ...(direction === "down"
      ? { top: Math.round(anchor.bottom + constraints.gap) }
      : {
          bottom: Math.round(layoutHeight - anchor.top + constraints.gap),
        }),
    width: Math.round(width),
    maxHeight: Math.floor(maxHeight),
  };
}

function liveCenterBounds(context: HTMLElement): FloatingMenuBounds {
  const visualViewport = window.visualViewport;
  const viewportLeft = visualViewport?.offsetLeft ?? 0;
  const viewportTop = visualViewport?.offsetTop ?? 0;
  const viewportWidth = visualViewport?.width ?? window.innerWidth;
  const viewportHeight = visualViewport?.height ?? window.innerHeight;
  let bounds: FloatingMenuBounds = {
    left: viewportLeft,
    top: viewportTop,
    right: viewportLeft + viewportWidth,
    bottom: viewportTop + viewportHeight,
  };
  const center = context.closest<HTMLElement>(".center");
  const centerBounds = center?.getBoundingClientRect();
  if (centerBounds && centerBounds.width > 0 && centerBounds.height > 0) {
    bounds = {
      left: Math.max(bounds.left, centerBounds.left),
      top: Math.max(bounds.top, centerBounds.top),
      right: Math.min(bounds.right, centerBounds.right),
      bottom: Math.min(bounds.bottom, centerBounds.bottom),
    };
  }
  const topbarBounds = center
    ?.querySelector<HTMLElement>(":scope > .topbar")
    ?.getBoundingClientRect();
  if (topbarBounds && topbarBounds.height > 0)
    bounds.top = Math.max(bounds.top, topbarBounds.bottom);
  return bounds;
}

export function useFloatingMenuPlacement(
  open: boolean,
  resolveTarget: () => FloatingMenuTarget | null,
  constraints: FloatingMenuConstraints,
): FloatingMenuPlacement | null {
  const [placement, setPlacement] = useState<FloatingMenuPlacement | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }

    let frame: number | null = null;
    const update = () => {
      frame = null;
      const target = resolveTarget();
      if (!target?.context.isConnected) return;
      const next = placeFloatingMenu(
        target.anchor,
        liveCenterBounds(target.context),
        document.documentElement.clientHeight || window.innerHeight,
        constraints,
        target.preferredWidth,
      );
      setPlacement((current) =>
        samePlacement(current, next) ? current : next,
      );
    };
    const schedule = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    const target = resolveTarget();
    const center = target?.context.closest<HTMLElement>(".center");
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    for (const element of new Set([...(target?.observe ?? []), center])) {
      if (element) resizeObserver?.observe(element);
    }
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    update();

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [constraints, open, resolveTarget]);

  return placement;
}
