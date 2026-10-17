import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ActivityFoldVisibilityPreference } from "../../shared/contracts";
import type {
  ActivityMaterializationMode,
  TranscriptActivityRangeState,
} from "../store";
import { ActivityMatrix, summarizeActivityMatrix } from "./ActivityMatrix";
import { PiLoader } from "./PiLoader";
import {
  DYNAMIC_FOLD_CLOSE_DELAY_MS,
  DYNAMIC_FOLD_EXPANDED_MIN_MS,
  useDynamicCardOpen,
} from "./transcript-activity";
import { ActivityItemVisibilityProvider } from "./transcript-activity-visibility";

const COMPACT_ACTIVITY_CARD_LIMIT = 24;

export type ActivityTelemetryItem = {
  id: string;
  kind: "thinking" | "tool";
  label?: string;
  live?: boolean;
  /** Deferred ranges describe omitted activity but do not correspond to a
   * mounted card until a bounded tail page has materialized. */
  deferred?: boolean;
};

export type ActivityFoldPresentation = "expanded" | "compact" | "collapsed";

function ActivityFoldOmission({
  contentId,
  active,
  matrix,
  status,
  label,
  title,
  onClick,
}: {
  contentId: string;
  active: boolean;
  matrix: ReturnType<typeof summarizeActivityMatrix>;
  status: "idle" | "loading" | "error";
  label: string;
  title: string;
  onClick: () => void;
}) {
  const controlRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const control = controlRef.current;
    const fold = control?.closest<HTMLElement>("[data-activity-fold]");
    return () => {
      if (!control?.contains(document.activeElement) || !fold) return;
      queueMicrotask(() =>
        fold
          .querySelector<HTMLButtonElement>(
            '[data-activity-fold-anchor="start"]',
          )
          ?.focus({ preventScroll: true }),
      );
    };
  }, []);

  return (
    <button
      ref={controlRef}
      type="button"
      className={`activity-fold__omission activity-fold__omission--${status}`}
      aria-controls={contentId}
      aria-expanded="false"
      aria-label={label}
      aria-description={matrix.description}
      aria-busy={status === "loading"}
      title={title}
      data-activity-fold-anchor="start"
      data-activity-range={status}
      onClick={onClick}
    >
      {status === "loading" ? (
        <PiLoader size={14} aria-hidden />
      ) : status === "error" ? (
        <AlertCircle size={14} aria-hidden />
      ) : (
        <ChevronRight size={14} aria-hidden />
      )}
      <span>
        {status === "loading"
          ? "Loading earlier activity…"
          : status === "error"
            ? "Retry earlier activity"
            : "Earlier activity"}
      </span>
      <ActivityMatrix {...matrix} active={active} />
    </button>
  );
}

export function ResponseActivityFold({
  visibility,
  lifecycleActive,
  closeRequested,
  initialManualPresentation = null,
  onManualPresentationChange,
  deferredRanges = [],
  telemetry = [],
  onMaterializeRanges,
  onPreserveAnchor,
  children,
}: {
  visibility: ActivityFoldVisibilityPreference;
  lifecycleActive: boolean;
  closeRequested: boolean;
  initialManualPresentation?: ActivityFoldPresentation | null;
  onManualPresentationChange?: (presentation: ActivityFoldPresentation) => void;
  deferredRanges?: readonly TranscriptActivityRangeState[];
  telemetry?: readonly ActivityTelemetryItem[];
  onMaterializeRanges?: (
    cursors: readonly string[],
    beforeCommit: () => void,
    mode?: ActivityMaterializationMode,
  ) => Promise<void>;
  onPreserveAnchor?: (
    element: HTMLElement,
    alignment: "start" | "center" | "end",
  ) => void;
  children: React.ReactNode;
}) {
  const contentId = useId();
  const foldRef = useRef<HTMLElement>(null);
  const topControlRef = useRef<HTMLButtonElement>(null);
  const lowerControlRef = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef<"upper" | "lower" | null>(null);
  const materializationAnchor = useRef<"start" | "center" | "end">("start");
  const [manualPresentation, setManualPresentation] =
    useState<ActivityFoldPresentation | null>(initialManualPresentation);
  const [inspectionHeld, setInspectionHeld] = useState(false);
  const dynamicVisible = useDynamicCardOpen(
    visibility === "dynamic",
    lifecycleActive,
    closeRequested,
    DYNAMIC_FOLD_EXPANDED_MIN_MS,
    undefined,
    DYNAMIC_FOLD_CLOSE_DELAY_MS,
  );
  const defaultPresentation: ActivityFoldPresentation =
    visibility === "expanded"
      ? "expanded"
      : visibility === "compact" || (visibility === "dynamic" && dynamicVisible)
        ? "compact"
        : "collapsed";
  const presentation: ActivityFoldPresentation =
    manualPresentation ??
    (visibility === "dynamic" && inspectionHeld
      ? "compact"
      : defaultPresentation);
  const open = presentation !== "collapsed";
  const [materialized, setMaterialized] = useState(open);

  const cardTelemetry = useMemo(
    () => telemetry.filter((item) => !item.deferred),
    [telemetry],
  );
  const compactVisibleIds = useMemo(() => {
    if (presentation !== "compact") return null;
    return new Set(
      cardTelemetry.slice(-COMPACT_ACTIVITY_CARD_LIMIT).map((item) => item.id),
    );
  }, [cardTelemetry, presentation]);
  const hasDeferredPrefix = deferredRanges.length > 0;
  const hasLoadedPrefix = cardTelemetry.length > COMPACT_ACTIVITY_CARD_LIMIT;
  const compactEquivalentToExpanded = !hasDeferredPrefix && !hasLoadedPrefix;
  const showOmission =
    (presentation === "compact" && (hasDeferredPrefix || hasLoadedPrefix)) ||
    (presentation === "expanded" && hasDeferredPrefix);
  const deferredError = deferredRanges.find(
    (range) => range.status === "error",
  );
  const deferredLoading = deferredRanges.some(
    (range) => range.status === "loading",
  );

  const latestMatrix = summarizeActivityMatrix(telemetry, lifecycleActive);
  const matrixDescription = latestMatrix.description;
  const kindIndicators = (
    <ActivityMatrix {...latestMatrix} active={lifecycleActive} />
  );
  // The omission owns only the hidden prefix, never the already visible tail.
  const earlierMatrix = summarizeActivityMatrix(
    telemetry.filter(
      (item) =>
        item.deferred || (compactVisibleIds && !compactVisibleIds.has(item.id)),
    ),
    lifecycleActive,
    "Earlier",
  );

  const requestMaterialization = useCallback(
    (mode: ActivityMaterializationMode, automatic: boolean) => {
      if (!onMaterializeRanges) return;
      if (
        mode === "tail" &&
        cardTelemetry.length >= COMPACT_ACTIVITY_CARD_LIMIT
      )
        return;
      const candidates =
        mode === "all"
          ? deferredRanges
          : deferredRanges.length > 0
            ? [deferredRanges[deferredRanges.length - 1]!]
            : [];
      const cursors = candidates
        .filter(
          (range) =>
            range.status !== "loading" &&
            (!automatic || range.status === "idle"),
        )
        .map((range) => range.cursor);
      if (cursors.length === 0) return;
      void onMaterializeRanges(
        cursors,
        () => {
          if (foldRef.current)
            onPreserveAnchor?.(foldRef.current, materializationAnchor.current);
        },
        mode,
      );
    },
    [
      cardTelemetry.length,
      deferredRanges,
      onMaterializeRanges,
      onPreserveAnchor,
    ],
  );

  useEffect(() => {
    if (open && !materialized) setMaterialized(true);
  }, [materialized, open]);

  useEffect(() => {
    if (presentation === "collapsed") return;
    requestMaterialization(presentation === "expanded" ? "all" : "tail", true);
  }, [presentation, requestMaterialization]);

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
    anchor: "start" | "center" | "end" = focusTarget === "upper"
      ? "start"
      : "end",
  ) => {
    focusAfterToggle.current = focusTarget;
    materializationAnchor.current = anchor;
    setManualPresentation(next);
    onManualPresentationChange?.(next);
  };

  const expandToCompact = (
    focusTarget: "upper" | "lower",
    anchor: "start" | "center" | "end",
  ) => {
    choosePresentation("compact", focusTarget, anchor);
    if (deferredRanges.at(-1)?.status === "error")
      requestMaterialization("tail", false);
  };

  const collapseTarget: ActivityFoldPresentation =
    presentation === "expanded" && !compactEquivalentToExpanded
      ? "compact"
      : "collapsed";

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
        aria-description={edge === "upper" ? matrixDescription : undefined}
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
        {edge === "upper" ? kindIndicators : null}
      </button>
    );
  };

  const omissionStatus = deferredError
    ? "error"
    : deferredLoading
      ? "loading"
      : "idle";
  const omissionLabel = deferredError
    ? "Retry loading all earlier assistant activity"
    : deferredLoading
      ? "Loading earlier assistant activity"
      : "Show all earlier assistant activity";

  return (
    <section
      ref={foldRef}
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
          className={`activity-fold__disclosure ${deferredError ? "activity-fold__disclosure--error" : ""}`}
          aria-controls={contentId}
          aria-expanded="false"
          aria-label="Expand assistant activity"
          aria-description={matrixDescription}
          title={deferredError?.error ?? "Show recent assistant activity"}
          data-activity-fold-anchor="center"
          onClick={() => expandToCompact("upper", "center")}
        >
          <ChevronRight size={14} aria-hidden />
          <span>Activity</span>
          {kindIndicators}
        </button>
      )}
      <div id={contentId} className="activity-fold__content" hidden={!open}>
        {showOmission ? (
          <ActivityFoldOmission
            contentId={contentId}
            active={lifecycleActive}
            matrix={earlierMatrix}
            status={omissionStatus}
            label={omissionLabel}
            title={deferredError?.error ?? omissionLabel}
            onClick={() => {
              materializationAnchor.current = "start";
              if (presentation === "compact")
                choosePresentation("expanded", "upper", "start");
              if (deferredError || presentation === "expanded")
                requestMaterialization("all", false);
            }}
          />
        ) : null}
        <ActivityItemVisibilityProvider visibleIds={compactVisibleIds}>
          {materialized || open ? children : null}
        </ActivityItemVisibilityProvider>
      </div>
      {open ? boundary("lower") : null}
    </section>
  );
}
