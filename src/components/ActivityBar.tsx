import { AlertTriangle, Pause } from "lucide-react";
import { memo } from "react";
import { shallowEqual, useAppState } from "../store";

/**
 * Quiet composer-adjacent status for automatic retries and a concise Pending
 * count. Tool execution remains in its chronological Transcript cards instead
 * of being duplicated here.
 */
export const ActivityBar = memo(function ActivityBar() {
  const state = useAppState(
    (source) => ({
      retry: source.retry,
      queue: source.queue,
    }),
    shallowEqual,
  );
  const pending = state.queue.steering.length + state.queue.followUp.length;

  if (!state.retry && pending === 0) return null;

  return (
    <div className="activity">
      {state.retry ? (
        <div
          className="activity__live"
          role="status"
          aria-label="Retry status"
          aria-atomic="false"
        >
          <span className="chip chip--warning chip--live">
            <AlertTriangle size={12} aria-hidden />
            Retry {state.retry.attempt}/{state.retry.maxAttempts}
            {state.retry.message ? ` — ${state.retry.message}` : ""}
          </span>
        </div>
      ) : null}
      {pending > 0 ? (
        <span
          className={`chip ${state.queue.paused ? "chip--warning" : "chip--info"}`}
        >
          {state.queue.paused ? <Pause size={12} aria-hidden /> : null}
          {pending} {state.queue.paused ? "Paused" : "Pending"}
        </span>
      ) : null}
    </div>
  );
});
