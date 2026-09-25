import { AlertTriangle, Loader2 } from "lucide-react";
import { memo } from "react";
import { shallowEqual, useAppState } from "../store";

function RetryStatus({
  label,
  reason,
  tone,
}: {
  label: string;
  reason?: string;
  tone: "info" | "warning";
}) {
  const Icon = tone === "info" ? Loader2 : AlertTriangle;
  return (
    <span className={`chip chip--${tone} chip--live activity__retry`}>
      <span className="activity__retry-label">
        <Icon
          size={12}
          className={tone === "info" ? "spin" : undefined}
          aria-hidden
        />
        {label}
      </span>
      {reason ? (
        <span className="activity__retry-reason"> — {reason}</span>
      ) : null}
    </span>
  );
}

/**
 * Current Pi phase, independent of the trigger or this browser's command receipts.
 * Optional event/snapshot details enrich a state; they never gate its visibility.
 * Tool execution remains in its chronological Transcript cards instead
 * of being duplicated here.
 */
export const ActivityBar = memo(function ActivityBar() {
  const state = useAppState(
    (source) => ({
      runState: source.runState,
      retry: source.retry,
      summarizationRetry: source.summarizationRetry,
      queue: source.queue,
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
      {compacting ? (
        <div
          className="activity__live"
          role="status"
          aria-label="Context compaction status"
        >
          <RetryStatus
            tone="info"
            label={
              summaryRetry
                ? `Compaction retry ${summaryRetry.attempt}/${summaryRetry.maxAttempts} — waiting`
                : "Compacting context"
            }
            reason={summaryRetry?.message}
          />
        </div>
      ) : null}
      {!compacting && summaryRetry ? (
        <div
          className="activity__live"
          role="status"
          aria-label="Summary retry status"
        >
          <RetryStatus
            tone="warning"
            label={`Summary retry ${summaryRetry.attempt}/${summaryRetry.maxAttempts} — waiting`}
            reason={summaryRetry.message}
          />
        </div>
      ) : null}
      {retrying ? (
        <div
          className="activity__live"
          role="status"
          aria-label="Retry status"
          aria-atomic="false"
        >
          <RetryStatus
            tone="warning"
            label={
              state.retry
                ? `Retry ${state.retry.attempt}/${state.retry.maxAttempts}`
                : "Retrying"
            }
            reason={state.retry?.message}
          />
        </div>
      ) : null}
      {pending > 0 ? (
        <span className="chip chip--info">{pending} Pending</span>
      ) : null}
    </div>
  );
});
