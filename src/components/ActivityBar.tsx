import { AlertTriangle } from "lucide-react";
import { memo } from "react";
import { selectedRunState } from "../app-state";
import { shallowEqual, useAppState } from "../store";
import { PiLoader } from "./PiLoader";

function RetryStatus({
  label,
  reason,
  status,
  compacting = false,
}: {
  label: string;
  reason?: string;
  status: string;
  compacting?: boolean;
}) {
  const Icon = compacting ? PiLoader : AlertTriangle;
  return (
    <span
      className={`chip chip--${compacting ? "activity-event" : "warning"} chip--live`}
      role="status"
      aria-label={status}
      title={reason}
    >
      <Icon size={12} aria-hidden />
      {label}
    </span>
  );
}

/**
 * Current Pi phase, independent of the trigger or this browser's command receipts.
 * Optional event/snapshot details enrich a state; they never gate its visibility.
 * Tool execution remains in its chronological Transcript cards instead
 * of being duplicated here.
 */
export const ActivityBar = memo(function ActivityBar({
  onJumpToPending,
}: {
  onJumpToPending: () => void;
}) {
  const state = useAppState(
    (source) => ({
      runState: selectedRunState(source),
      retry: source.live.retry,
      summarizationRetry: source.live.summarizationRetry,
      queue: source.live.queue,
    }),
    shallowEqual,
  );
  const pending = state.queue.totalCount;
  const compacting = state.runState === "compacting";
  const retrying = state.runState === "retrying";

  const summaryRetry = state.summarizationRetry;
  if (!compacting && !retrying && !summaryRetry && pending === 0) return null;

  return (
    <div className="activity">
      {compacting || summaryRetry ? (
        <RetryStatus
          compacting={compacting}
          status={compacting ? "Context compaction status" : "Summary retry status"}
          label={
            compacting
              ? summaryRetry ? "Retrying compaction" : "Compacting context"
              : "Retrying summary"
          }
          reason={summaryRetry?.message}
        />
      ) : null}
      {retrying ? (
        <RetryStatus
          status="Retry status"
          label="Retrying"
          reason={state.retry?.message}
        />
      ) : null}
      {pending > 0 ? (
        <button
          type="button"
          className="chip activity__pending"
          onClick={onJumpToPending}
          aria-label={`Jump to ${pending} pending ${pending === 1 ? "item" : "items"}`}
          title="Jump to Pending input"
        >
          {pending} Pending
        </button>
      ) : null}
    </div>
  );
});
