import { useEffect, useRef, useState } from "react";
import type { ActivityTelemetryItem } from "./transcript-fold";

export function summarizeActivityMatrix(
  telemetry: readonly ActivityTelemetryItem[],
  active: boolean,
  scope: "Recent" | "Earlier" = "Recent",
) {
  // Presence hints cannot tell us the chronological contents of an opaque range.
  const lastDeferred = telemetry.reduce(
    (last, item, index) => (item.deferred ? index : last),
    -1,
  );
  const items = telemetry.slice(lastDeferred + 1).slice(-9);
  const description = items.length
    ? `${scope} activity, oldest to newest: ${items
        .map(
          (item) =>
            `${item.kind === "thinking" ? "Thinking" : "Tool"}${active && item.live ? " (active)" : ""}`,
        )
        .join(
          ", ",
        )}.${lastDeferred >= 0 && items.length < 9 ? " Earlier activity not loaded." : ""}`
    : lastDeferred >= 0
      ? `Expand to load ${scope.toLowerCase()} activity.`
      : "Waiting for activity.";
  return { items, description };
}

export function ActivityMatrix({
  items,
  description,
  active,
}: {
  items: readonly ActivityTelemetryItem[];
  description: string;
  active: boolean;
}) {
  const full = items.length === 9;
  const previousFull = useRef(full);
  const [lighting, setLighting] = useState(false);
  useEffect(() => {
    const wasFull = previousFull.current;
    previousFull.current = full;
    if (!full) {
      setLighting(false);
      return;
    }
    if (wasFull) return;
    // A full historical matrix mounts quietly; rolling updates do not reflash.
    setLighting(true);
    const timer = window.setTimeout(() => setLighting(false), 800);
    return () => window.clearTimeout(timer);
  }, [full]);
  return (
    <span
      className={`activity-fold__matrix${full ? " activity-fold__matrix--full" : ""}${full && lighting ? " activity-fold__matrix--lighting" : ""}`}
      title={description}
      aria-hidden
    >
      {Array.from({ length: 9 }, (_, index) => {
        const item = items[index];
        return (
          <span
            key={item?.id ?? `empty:${index}`}
            data-activity-id={item?.id}
            title={item?.label}
            className={
              item
                ? `activity-fold__kind activity-fold__kind--${item.kind}${active && item.live ? " activity-fold__kind--live" : ""}`
                : "activity-fold__cell-empty"
            }
          />
        );
      })}
    </span>
  );
}
