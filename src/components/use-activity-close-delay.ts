import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../input-device";

/** Only activity observed while live gets a grace period after it settles. */
export function useActivityCloseDelay(
  active: boolean,
  minimumOpenMs: number,
  closeDelayMs: number,
) {
  const openedAt = useRef<number | null>(null);
  const [holding, setHolding] = useState(false);
  useEffect(() => {
    if (active) {
      openedAt.current ??= performance.now();
      setHolding(true);
      return;
    }
    const start = openedAt.current;
    if (start === null) return;
    const delay = prefersReducedMotion()
      ? 0
      : Math.max(closeDelayMs, minimumOpenMs - (performance.now() - start));
    const timer = window.setTimeout(() => {
      openedAt.current = null;
      setHolding(false);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [active, closeDelayMs, minimumOpenMs]);
  return active || holding;
}
