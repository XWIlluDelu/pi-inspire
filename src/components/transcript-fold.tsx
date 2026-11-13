import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ActivityFoldVisibilityPreference } from "../../shared/contracts";
import {
  ActivityItemVisibilityProvider,
  type ActivityReadingChoices,
} from "./transcript-activity-visibility";

const COMPACT_ACTIVITY_CARD_LIMIT = 24;

export type ActivityTelemetryItem = {
  id: string;
  kind: "thinking" | "tool";
  label?: string;
  /** Tool name for the collapsed text summary. */
  name?: string;
  /** A settled tool result reported an error. */
  failed?: boolean;
  live?: boolean;
};

export type ActivityFoldPresentation = "expanded" | "compact" | "collapsed";

/**
 * A collapsed group names what it did in words: the step count, the first
 * distinct tools (with repeat counts) and any failures, so a reader does not
 * have to expand a group just to learn whether something went wrong.
 */
function summarizeActivityText(telemetry: readonly ActivityTelemetryItem[]): {
  steps: string;
  tools: string;
  failed: number;
} {
  const total = telemetry.length;
  const counts = new Map<string, number>();
  let thinking = 0;
  let failed = 0;
  for (const item of telemetry) {
    if (item.failed) failed += 1;
    if (item.kind === "thinking") thinking += 1;
    else if (item.name) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) =>
    count > 1 ? `${name} ×${count}` : name,
  );
  if (thinking > 0 && names.length < 3)
    names.unshift(thinking > 1 ? `thinking ×${thinking}` : "thinking");
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return {
    steps: total === 0 ? "" : total === 1 ? "1 step" : `${total} steps`,
    tools: shown.join(" · ") + (rest > 0 ? ` +${rest}` : ""),
    failed,
  };
}

function ActivityFoldOmission({
  contentId,
  onClick,
}: {
  contentId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="activity-fold__omission"
      aria-controls={contentId}
      aria-expanded="false"
      aria-label="Show all earlier assistant activity"
      data-activity-fold-anchor="start"
      onClick={onClick}
    >
      <ChevronRight size={14} aria-hidden />
      <span>Earlier activity</span>
    </button>
  );
}

export function ResponseActivityFold({
  visibility,
  lifecycleActive,
  closeRequested,
  initialManualPresentation = null,
  onManualPresentationChange,
  readingChoices,
  telemetry = [],
  children,
}: {
  visibility: ActivityFoldVisibilityPreference;
  lifecycleActive: boolean;
  closeRequested: boolean;
  initialManualPresentation?: ActivityFoldPresentation | null;
  onManualPresentationChange?: (presentation: ActivityFoldPresentation) => void;
  readingChoices?: ActivityReadingChoices;
  telemetry?: readonly ActivityTelemetryItem[];
  children: React.ReactNode;
}) {
  const contentId = useId();
  const topControlRef = useRef<HTMLButtonElement>(null);
  const lowerControlRef = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef<"upper" | "lower" | null>(null);
  const [manualPresentation, setManualPresentation] =
    useState<ActivityFoldPresentation | null>(initialManualPresentation);
  const [inspectionHeld, setInspectionHeld] = useState(false);
  const defaultPresentation: ActivityFoldPresentation =
    visibility === "expanded"
      ? "expanded"
      : visibility === "compact" ||
          (visibility === "dynamic" && lifecycleActive && !closeRequested)
        ? "compact"
        : "collapsed";
  const presentation: ActivityFoldPresentation =
    manualPresentation ??
    (visibility === "dynamic" && inspectionHeld
      ? "compact"
      : defaultPresentation);
  const open = presentation !== "collapsed";
  const localReadingChoices = useRef<ActivityReadingChoices>(new Map());

  const compactVisibleIds =
    presentation === "compact"
      ? new Set(
          telemetry.slice(-COMPACT_ACTIVITY_CARD_LIMIT).map((item) => item.id),
        )
      : null;
  const hasEarlier = telemetry.length > COMPACT_ACTIVITY_CARD_LIMIT;

  const textSummary = summarizeActivityText(telemetry);
  const summary = textSummary.steps ? (
    <span className="activity-fold__summary">
      {[textSummary.steps, textSummary.tools].filter(Boolean).join(" · ")}
      {textSummary.failed > 0 ? (
        <>
          {" · "}
          <span className="activity-fold__summary-failed">
            {textSummary.failed} failed
          </span>
        </>
      ) : null}
    </span>
  ) : null;
  useEffect(() => {
    const target = focusAfterToggle.current;
    if (!target) return;
    focusAfterToggle.current = null;
    const control =
      target === "upper" || !open
        ? topControlRef.current
        : lowerControlRef.current;
    control?.focus({ preventScroll: true });
  }, [open, presentation]);

  const choosePresentation = (
    next: ActivityFoldPresentation,
    focusTarget: "upper" | "lower",
  ) => {
    focusAfterToggle.current = focusTarget;
    setManualPresentation(next);
    onManualPresentationChange?.(next);
  };

  const collapseTarget: ActivityFoldPresentation =
    presentation === "expanded" && hasEarlier ? "compact" : "collapsed";

  const boundary = (edge: "upper" | "lower") => {
    const action = collapseTarget === "compact" ? "Compact" : "Collapse";
    return (
      <button
        ref={edge === "upper" ? topControlRef : lowerControlRef}
        type="button"
        className={`activity-fold__boundary activity-fold__boundary--${edge}`}
        aria-controls={contentId}
        aria-expanded="true"
        aria-label={`${action} assistant activity from the ${edge} boundary`}
        title={`${action} activity`}
        data-activity-fold-anchor={edge === "upper" ? "start" : "end"}
        onClick={() => choosePresentation(collapseTarget, edge)}
      >
        {edge === "upper" ? (
          <ChevronDown size={14} aria-hidden />
        ) : (
          <ChevronUp size={14} aria-hidden />
        )}
        <span>{edge === "upper" ? "Activity" : `${action} activity`}</span>
        {edge === "upper" ? summary : null}
      </button>
    );
  };

  return (
    <section
      className={`activity-fold activity-fold--${presentation}`}
      aria-label="Assistant activity"
      data-activity-fold={open ? "open" : "closed"}
      data-activity-fold-presentation={presentation}
      onFocusCapture={() => {
        if (open) setInspectionHeld(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setInspectionHeld(false);
      }}
    >
      {open ? (
        boundary("upper")
      ) : (
        <button
          ref={topControlRef}
          type="button"
          className="activity-fold__disclosure"
          aria-controls={contentId}
          aria-expanded="false"
          aria-label="Expand assistant activity"
          title="Show recent assistant activity"
          data-activity-fold-anchor="center"
          onClick={() => choosePresentation("compact", "upper")}
        >
          <ChevronRight size={14} aria-hidden />
          <span>Activity</span>
          {summary}
        </button>
      )}
      <div id={contentId} className="activity-fold__content" hidden={!open}>
        {presentation === "compact" && hasEarlier ? (
          <ActivityFoldOmission
            contentId={contentId}
            onClick={() => choosePresentation("expanded", "upper")}
          />
        ) : null}
        <ActivityItemVisibilityProvider
          visibleIds={compactVisibleIds}
          readingChoices={readingChoices ?? localReadingChoices.current}
        >
          {open ? children : null}
        </ActivityItemVisibilityProvider>
      </div>
      {open ? boundary("lower") : null}
    </section>
  );
}
