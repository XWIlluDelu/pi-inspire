import { useEffect, useMemo, useRef, useState } from "react";

export const CARD_TRANSITION_MS = 180;
export const DYNAMIC_THINKING_EXPANDED_MIN_MS = 1_800;
export const DYNAMIC_TOOL_EXPANDED_MIN_MS = 1_600;
const DYNAMIC_TOOL_COLLAPSED_MIN_MS = 800;

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

type DynamicActivityPhase = "cards" | "compacting" | "compact";

/** A card that the browser actually observes stays expanded long enough to be
 * perceived. Settled history starts closed and never replays old lifecycle
 * animation. */
export function useDynamicCardOpen(
  dynamic: boolean,
  lifecycleActive: boolean,
  closeRequested: boolean,
  minimumOpenMs: number,
  onClosed?: () => void,
): boolean {
  const [open, setOpen] = useState(dynamic && lifecycleActive);
  const enteredAt = useRef<number | null>(
    dynamic && lifecycleActive ? performance.now() : null,
  );
  const closedNotified = useRef(false);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  useEffect(() => {
    if (!dynamic) {
      enteredAt.current = null;
      closedNotified.current = false;
      return;
    }

    if (lifecycleActive && !closeRequested) {
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

    const entered = enteredAt.current ?? performance.now();
    enteredAt.current = entered;
    const minimum = prefersReducedMotion() ? 0 : minimumOpenMs;
    const remaining = Math.max(0, minimum - (performance.now() - entered));
    const timer = window.setTimeout(() => setOpen(false), remaining);
    return () => window.clearTimeout(timer);
  }, [closeRequested, dynamic, lifecycleActive, minimumOpenMs, open]);

  return open;
}

/** Tool calls and displayed custom messages share one density lifecycle.
 * Cards collapse independently; a batch changes geometry only after every card
 * has closed, the collapsed state has remained perceptible, and its next Pi
 * boundary has arrived. */
function useDynamicActivityBatch(
  dynamic: boolean,
  lifecycleObserved: boolean,
  compactRequested: boolean,
  hasActivities: boolean,
  inspectionHeld: boolean,
  allCardsClosed: boolean,
) {
  const [phase, setPhase] = useState<DynamicActivityPhase>(
    dynamic && !lifecycleObserved ? "compact" : "cards",
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
    if (!dynamic || !hasActivities) {
      observedLifecycle.current = lifecycleObserved;
      setPhase("cards");
      return;
    }

    if (lifecycleObserved) {
      observedLifecycle.current = true;
      if (!compactRequested) {
        if (phase !== "cards") setPhase("cards");
        return;
      }
    }

    if (!observedLifecycle.current) {
      // Settled history chooses final density without replaying unseen stages.
      if (phase !== "compact") setPhase("compact");
      return;
    }

    if (!compactRequested) return;
    if (inspectionHeld) {
      if (phase === "compacting") setPhase("cards");
      return;
    }
    if (!allCardsClosed || phase === "compact") return;

    if (phase === "compacting") {
      const timer = window.setTimeout(
        () => setPhase("compact"),
        prefersReducedMotion() ? 0 : CARD_TRANSITION_MS,
      );
      return () => window.clearTimeout(timer);
    }

    const closedAt = allClosedAt.current ?? performance.now();
    const collapseTime = prefersReducedMotion() ? 0 : CARD_TRANSITION_MS;
    const minimumCollapsed = prefersReducedMotion()
      ? 0
      : DYNAMIC_TOOL_COLLAPSED_MIN_MS;
    const remaining = Math.max(
      0,
      collapseTime + minimumCollapsed - (performance.now() - closedAt),
    );
    const timer = window.setTimeout(() => {
      if (phaseRef.current === "cards") setPhase("compacting");
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [
    allCardsClosed,
    compactRequested,
    dynamic,
    hasActivities,
    inspectionHeld,
    lifecycleObserved,
    phase,
  ]);

  return {
    compact: phase === "compact",
    closing: phase === "compacting",
    phase,
  };
}

/** Tracks activity-card inspection and settlement independently from transcript
 * content. Keeping this lifecycle out of Transcript makes its temporal rules
 * independently testable without creating a second transcript authority. */
export function useDynamicActivityGroup(
  dynamic: boolean,
  lifecycleObserved: boolean,
  compactRequested: boolean,
  activityKeys: string[],
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
    compactRequested,
    activityKeys.length > 0,
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
