import { useEffect, useMemo, useRef, useState } from "react";

export const CARD_TRANSITION_MS = 180;
export const DYNAMIC_THINKING_EXPANDED_MIN_MS = 1_800;
export const DYNAMIC_THINKING_CLOSE_DELAY_MS = 600;
export const DYNAMIC_TOOL_EXPANDED_MIN_MS = 1_500;
export const DYNAMIC_TOOL_CLOSE_DELAY_MS = 500;
export const DYNAMIC_CUSTOM_EXPANDED_MIN_MS = 1_500;
export const DYNAMIC_CUSTOM_CLOSE_DELAY_MS = 500;
export const DYNAMIC_FOLD_EXPANDED_MIN_MS = 2_400;
export const DYNAMIC_FOLD_CLOSE_DELAY_MS = 800;
const DYNAMIC_TOOL_COMPACT_MIN_MS = 800;

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

type DynamicActivityPhase = "cards" | "collapsing" | "collapsed";

/** A card that the browser actually observes stays expanded long enough to be
 * perceived. Settled history starts closed and never replays old lifecycle
 * animation. */
export function useDynamicCardOpen(
  dynamic: boolean,
  lifecycleActive: boolean,
  closeRequested: boolean,
  minimumOpenMs: number,
  onClosed?: () => void,
  minimumCloseDelayMs = 0,
): boolean {
  const [open, setOpen] = useState(dynamic && lifecycleActive);
  const enteredAt = useRef<number | null>(
    dynamic && lifecycleActive ? performance.now() : null,
  );
  const closedNotified = useRef(false);
  const closeRequestedAt = useRef<number | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  useEffect(() => {
    if (!dynamic) {
      enteredAt.current = null;
      closeRequestedAt.current = null;
      closedNotified.current = false;
      return;
    }

    if (lifecycleActive && !closeRequested) {
      closeRequestedAt.current = null;
      if (!open) {
        enteredAt.current = performance.now();
        closedNotified.current = false;
        setOpen(true);
      }
      return;
    }

    if (!open) {
      if (!closedNotified.current) {
        closedNotified.current = true;
        onClosedRef.current?.();
      }
      return;
    }

    const now = performance.now();
    const entered = enteredAt.current ?? now;
    enteredAt.current = entered;
    if (closeRequestedAt.current === null) closeRequestedAt.current = now;
    const reducedMotion = prefersReducedMotion();
    const openMinimum = reducedMotion ? 0 : minimumOpenMs;
    const closeMinimum = reducedMotion ? 0 : minimumCloseDelayMs;
    const remaining = Math.max(
      0,
      openMinimum - (now - entered),
      closeMinimum - (now - closeRequestedAt.current),
    );
    const timer = window.setTimeout(() => setOpen(false), remaining);
    return () => window.clearTimeout(timer);
  }, [
    closeRequested,
    dynamic,
    lifecycleActive,
    minimumCloseDelayMs,
    minimumOpenMs,
    open,
  ]);

  return open;
}

/** Tool calls and displayed custom messages share one density lifecycle.
 * Cards enter the Compact state independently; a multi-activity run reaches
 * Collapsed only after every card body has closed, Compact has remained
 * perceptible, and its next Pi boundary has arrived. A singleton remains a
 * useful compact card. */
function useDynamicActivityBatch(
  dynamic: boolean,
  lifecycleObserved: boolean,
  collapseRequested: boolean,
  collapseEligible: boolean,
  inspectionHeld: boolean,
  allCardsClosed: boolean,
) {
  const [phase, setPhase] = useState<DynamicActivityPhase>(
    dynamic && collapseEligible && !lifecycleObserved ? "collapsed" : "cards",
  );
  const phaseRef = useRef(phase);
  const observedLifecycle = useRef(lifecycleObserved);
  const allClosedAt = useRef<number | null>(
    allCardsClosed ? performance.now() : null,
  );

  phaseRef.current = phase;

  useEffect(() => {
    if (allCardsClosed) {
      if (allClosedAt.current === null) allClosedAt.current = performance.now();
    } else {
      allClosedAt.current = null;
    }
  }, [allCardsClosed]);

  useEffect(() => {
    if (!dynamic || !collapseEligible) {
      observedLifecycle.current = lifecycleObserved;
      setPhase("cards");
      return;
    }

    if (lifecycleObserved) {
      observedLifecycle.current = true;
      if (!collapseRequested) {
        if (phase !== "cards") setPhase("cards");
        return;
      }
    }

    if (!observedLifecycle.current) {
      // Settled history chooses final density without replaying unseen stages.
      if (phase !== "collapsed") setPhase("collapsed");
      return;
    }

    if (!collapseRequested) return;
    if (inspectionHeld) {
      if (phase === "collapsing") setPhase("cards");
      return;
    }
    if (!allCardsClosed || phase === "collapsed") return;

    if (phase === "collapsing") {
      const timer = window.setTimeout(
        () => setPhase("collapsed"),
        prefersReducedMotion() ? 0 : CARD_TRANSITION_MS,
      );
      return () => window.clearTimeout(timer);
    }

    const closedAt = allClosedAt.current ?? performance.now();
    const collapseTime = prefersReducedMotion() ? 0 : CARD_TRANSITION_MS;
    const minimumCollapsed = prefersReducedMotion()
      ? 0
      : DYNAMIC_TOOL_COMPACT_MIN_MS;
    const remaining = Math.max(
      0,
      collapseTime + minimumCollapsed - (performance.now() - closedAt),
    );
    const timer = window.setTimeout(() => {
      if (phaseRef.current === "cards") setPhase("collapsing");
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [
    allCardsClosed,
    collapseRequested,
    dynamic,
    collapseEligible,
    inspectionHeld,
    lifecycleObserved,
    phase,
  ]);

  return {
    collapsed: phase === "collapsed",
    closing: phase === "collapsing",
    phase,
  };
}

/** Tracks activity-card inspection and settlement independently from transcript
 * content. Keeping this lifecycle out of Transcript makes its temporal rules
 * independently testable without creating a second transcript authority. */
export function useDynamicActivityGroup(
  dynamic: boolean,
  lifecycleObserved: boolean,
  collapseRequested: boolean,
  activityKeys: string[],
  collapseEligible: boolean,
) {
  const keySignature = JSON.stringify(activityKeys);
  const currentKeys = useMemo(
    () => new Set<string>(JSON.parse(keySignature)),
    [keySignature],
  );
  const [heldActivityIds, setHeldActivityIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [closedActivityIds, setClosedActivityIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const retainCurrent = (current: Set<string>) => {
      const next = new Set([...current].filter((id) => currentKeys.has(id)));
      return next.size === current.size ? current : next;
    };
    setHeldActivityIds(retainCurrent);
    setClosedActivityIds(retainCurrent);
  }, [currentKeys]);

  const inspectionHeld = [...heldActivityIds].some((id) => currentKeys.has(id));
  const allCardsClosed =
    activityKeys.length > 0 &&
    activityKeys.every((id) => closedActivityIds.has(id));
  const batch = useDynamicActivityBatch(
    dynamic,
    lifecycleObserved,
    collapseRequested,
    collapseEligible,
    inspectionHeld,
    allCardsClosed,
  );

  return {
    ...batch,
    markClosed(activityKey: string) {
      setClosedActivityIds((current) =>
        current.has(activityKey) ? current : new Set(current).add(activityKey),
      );
    },
    setInspectionHeld(activityKey: string, held: boolean) {
      setHeldActivityIds((current) => {
        const next = new Set(current);
        if (held) next.add(activityKey);
        else next.delete(activityKey);
        return next;
      });
    },
  };
}
