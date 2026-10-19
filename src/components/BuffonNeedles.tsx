import { useEffect, useRef, useState } from "react";
import { countBusySessions } from "../../shared/session-activity";
import { useAppState } from "../store";

const REFERENCE_WIDTH = 2400; // Drawable CSS pixels, independent of screen DPI.
const MAX_LIFETIME_MS = 4500;
const EDGE_INSET = 2;

interface TitlebarNeedle {
  id: number;
  x: number;
  y: number;
  length: number;
  angle: number;
  role: "tool" | "think";
  lifetimeMs: number;
}

/** A bounded distribution with most samples near the mode, without clamped tails. */
function triangular(min: number, mode: number, max: number): number {
  const sample = Math.random();
  const span = max - min;
  return sample < (mode - min) / span
    ? min + Math.sqrt(sample * span * (mode - min))
    : max - Math.sqrt((1 - sample) * span * (max - mode));
}

/** Independent needle arrivals and lifetimes, not a repeating batch animation. */
export function BuffonNeedles() {
  const [needles, setNeedles] = useState<TitlebarNeedle[]>([]);
  const nextId = useRef(0);
  const surface = useRef<HTMLDivElement>(null);
  const busyCount = useAppState((state) =>
    countBusySessions(state.sessionStatuses, state.externalSessionActivities),
  );

  useEffect(() => {
    const layer = surface.current;
    if (!layer) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const overlay = window.matchMedia(
      "(display-mode: window-controls-overlay)",
    );
    let rate = 0;
    let limit = 0;
    let width = 0;
    let height = 0;
    let drawableWidth = 0;
    let timer: number | null = null;

    const measure = () => {
      const bounds = layer.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      // Decoration samples the full strip without excluding foreground controls.
      drawableWidth = Math.max(0, width - EDGE_INSET * 2);
      rate = 3.6 * (1 + busyCount) * (drawableWidth / REFERENCE_WIDTH);
      // Allow maximum-lifetime occupancy plus random-arrival headroom.
      limit = Math.min(256, Math.ceil((rate * MAX_LIFETIME_MS) / 1000) + 12);
    };

    const canAnimate = () =>
      drawableWidth > 0 &&
      height > 0 &&
      !reduced.matches &&
      overlay.matches &&
      document.visibilityState === "visible";

    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      // Exponential waiting times give independent, irregular single arrivals.
      const delayMs = (-Math.log1p(-Math.random()) / rate) * 1000;
      timer = window.setTimeout(() => {
        timer = null;
        if (!canAnimate()) return;

        const needle: TitlebarNeedle = {
          id: nextId.current++,
          x: ((EDGE_INSET + Math.random() * drawableWidth) / width) * 100,
          y: 20 + Math.random() * 60,
          length: triangular(10, 22, 42),
          angle: Math.random() * 180,
          role: Math.random() < 0.5 ? "tool" : "think",
          lifetimeMs: triangular(1400, 2600, MAX_LIFETIME_MS),
        };
        // Saturation skips arrivals rather than cutting an existing fade short.
        setNeedles((previous) =>
          previous.length < limit ? [...previous, needle] : previous,
        );
        schedule();
      }, delayMs);
    };

    const evaluate = () => {
      clearTimer();
      measure();
      if (canAnimate()) schedule();
      else setNeedles([]);
    };

    evaluate();
    const resizeObserver = new ResizeObserver(evaluate);
    resizeObserver.observe(layer);
    document.addEventListener("visibilitychange", evaluate);
    reduced.addEventListener("change", evaluate);
    overlay.addEventListener("change", evaluate);

    return () => {
      clearTimer();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", evaluate);
      reduced.removeEventListener("change", evaluate);
      overlay.removeEventListener("change", evaluate);
      // State/size changes only retime arrivals; existing needles finish fading.
    };
  }, [busyCount]);

  return (
    <div ref={surface} className="window-titlebar__needles" aria-hidden="true">
      {needles.map((needle) => (
        <span
          key={needle.id}
          className={`window-titlebar__needle window-titlebar__needle--${needle.role}`}
          onAnimationEnd={() =>
            setNeedles((previous) =>
              previous.filter((entry) => entry.id !== needle.id),
            )
          }
          style={{
            left: `${needle.x}%`,
            top: `${needle.y}%`,
            width: `${needle.length}px`,
            transform: `translate(-50%, -50%) rotate(${needle.angle}deg)`,
            animationDuration: `${needle.lifetimeMs}ms`,
          }}
        />
      ))}
    </div>
  );
}
