import { AlertTriangle, Loader2 } from "lucide-react";
import { memo } from "react";
import { shallowEqual, useAppState } from "../store";

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
      queue: source.queue,
    }),
    shallowEqual,
  );
  const pending = state.queue.totalCount;
  const compacting = state.runState === "compacting";
  const retrying = state.runState === "retrying";

  if (!compacting && !retrying && pending === 0) return null;

  return (
    <div className="activity">
      {compacting ? (
        <div
          className="activity__live"
          role="status"
          aria-label="Context compaction status"
        >
          <span className="chip chip--info chip--live">
            <Loader2 size={12} className="spin" aria-hidden />
            Compacting context
          </span>
        </div>
      ) : null}
      {retrying ? (
        <div
          className="activity__live"
          role="status"
          aria-label="Retry status"
          aria-atomic="false"
        >
          <span className="chip chip--warning chip--live">
            <AlertTriangle size={12} aria-hidden />
            {state.retry
              ? `Retry ${state.retry.attempt}/${state.retry.maxAttempts}`
              : "Retrying"}
            {state.retry?.message ? ` — ${state.retry.message}` : ""}
          </span>
        </div>
      ) : null}
      {pending > 0 ? (
        <span className="chip chip--info">{pending} Pending</span>
      ) : null}
    </div>
  );
});
