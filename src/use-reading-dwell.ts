import { type RefObject, useEffect, useRef, useState } from "react";

const RESUME_GRACE_MS = 3_000;
// Matches the shared --dur-standard opacity exit.
const EXIT_MS = 150;
const words = new Intl.Segmenter(undefined, { granularity: "word" });

/** Coarse reading bands, including text without spaces; not a reading-speed estimate. */
export function readingDwellMs(text: string): number {
  const count = Array.from(words.segment(text)).filter(
    (part) => part.isWordLike,
  ).length;
  return count <= 10 ? 3_000 : count <= 30 ? 5_000 : 8_000;
}

/** Spend the reading budget only while visible and not being inspected. */
export function useReadingDwell<T extends HTMLElement>(
  durationMs: number | null,
  onDismiss: () => void,
  focusScope?: RefObject<HTMLElement | null>,
) {
  const ref = useRef<T>(null);
  const [leaving, setLeaving] = useState(false);
  const interaction = useRef<{ hovered: boolean; pressed: boolean } | null>(
    null,
  );

  useEffect(() => {
    setLeaving(false);
    const node = ref.current;
    if (durationMs === null || !node) return;

    let remaining = durationMs;
    let startedAt = 0;
    let paused = true;
    let inView = false;
    const pointer = (interaction.current ??= {
      hovered: node.matches(":hover"),
      pressed: false,
    });
    const focusRoot = focusScope?.current ?? node;
    let focused = focusRoot.contains(document.activeElement);
    let timer: ReturnType<typeof setTimeout>;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;

    const clear = () => {
      clearTimeout(timer);
      clearTimeout(exitTimer);
    };
    const reconcile = () => {
      const nextPaused =
        !inView ||
        pointer.hovered ||
        pointer.pressed ||
        focused ||
        document.hidden;
      if (nextPaused === paused) return;
      paused = nextPaused;
      if (paused) {
        clear();
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
        setLeaving(false);
      } else {
        remaining = Math.max(remaining, RESUME_GRACE_MS);
        startedAt = Date.now();
        timer = setTimeout(() => {
          if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            onDismiss();
          } else {
            setLeaving(true);
            exitTimer = setTimeout(onDismiss, EXIT_MS);
          }
        }, remaining);
      }
    };
    const enter = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointer.hovered = true;
      reconcile();
    };
    const leave = () => {
      pointer.hovered = false;
      reconcile();
    };
    const press = () => {
      pointer.pressed = true;
      reconcile();
    };
    const release = () => {
      pointer.pressed = false;
      reconcile();
    };
    const focus = () => {
      focused = true;
      reconcile();
    };
    const blur = (event: FocusEvent) => {
      focused = focusRoot.contains(event.relatedTarget as Node | null);
      reconcile();
    };

    node.addEventListener("pointerenter", enter);
    node.addEventListener("pointerleave", leave);
    node.addEventListener("pointerdown", press);
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", release);
    focusRoot.addEventListener("focusin", focus);
    focusRoot.addEventListener("focusout", blur);
    document.addEventListener("visibilitychange", reconcile);
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting && entry.intersectionRatio >= 0.5;
        reconcile();
      },
      { threshold: 0.5 },
    );
    observer.observe(node);
    reconcile();
    return () => {
      clear();
      observer.disconnect();
      node.removeEventListener("pointerenter", enter);
      node.removeEventListener("pointerleave", leave);
      node.removeEventListener("pointerdown", press);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      focusRoot.removeEventListener("focusin", focus);
      focusRoot.removeEventListener("focusout", blur);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [durationMs, onDismiss, focusScope]);

  return { ref, leaving };
}
