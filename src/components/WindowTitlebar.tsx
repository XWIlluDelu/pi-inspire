import { useEffect, useRef } from "react";
import { store, useAppState } from "../store";
import { BuffonNeedles } from "./BuffonNeedles";
import { Wordmark } from "./Wordmark";

/** Browser-owned controls remain native; this is only the overlay's drag surface. */
export function WindowTitlebar() {
  const needlesActive = useAppState((state) => state.prefs.titlebarNeedles);
  const completion = useAppState((state) => state.completedRunSequence);
  const lastCompletion = useRef(completion);
  const titlebar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = lastCompletion.current;
    lastCompletion.current = completion;
    if (completion === 0 || completion === previous) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (
      reducedMotion.matches ||
      document.visibilityState !== "visible" ||
      !window.matchMedia("(display-mode: window-controls-overlay)").matches
    )
      return;

    const animation = titlebar.current
      ?.querySelector(".wordmark__pi")
      ?.animate(
        [
          { textShadow: "0 0 0 transparent" },
          { textShadow: "0 0 6px currentColor", offset: 0.3 },
          { textShadow: "0 0 0 transparent" },
        ],
        { duration: 800, easing: "ease-out" },
      );
    const cancel = () => animation?.cancel();
    reducedMotion.addEventListener("change", cancel, { once: true });
    return () => {
      cancel();
      reducedMotion.removeEventListener("change", cancel);
    };
  }, [completion]);

  return (
    <div ref={titlebar} className="window-titlebar">
      <div className="window-titlebar__safe">
        {needlesActive ? <BuffonNeedles /> : null}
        <div className="window-titlebar__identity">
          <button
            type="button"
            className="window-titlebar__brand-button"
            onClick={() => store.setTitlebarNeedles(!needlesActive)}
            aria-label="Inspire — Buffon's needles"
            aria-pressed={needlesActive}
            title={
              needlesActive
                ? "Buffon's needles (active) — click to disable"
                : "Buffon's needles — click to toggle"
            }
          >
            <Wordmark />
          </button>
        </div>
      </div>
    </div>
  );
}
