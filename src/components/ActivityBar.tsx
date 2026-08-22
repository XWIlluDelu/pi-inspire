import { AlertTriangle, Loader2, Pause, XCircle } from "lucide-react";
import { useAppState } from "../store";

/**
 * Transient, truthful activity surface: tools currently executing, automatic
 * retries in progress, failed tool calls since the last settle, and a concise
 * pending-input count. Full pending text remains at the transcript boundary.
 */
export function ActivityBar() {
  const state = useAppState();
  const tools = Object.values(state.tools);
  const running = tools.filter((tool) => tool.phase === "running");
  const failed = tools.filter((tool) => tool.phase === "error");
  const pending = state.queue.steering.length + state.queue.followUp.length;

  if (
    running.length === 0 &&
    failed.length === 0 &&
    !state.retry &&
    pending === 0
  )
    return null;

  const hasLiveStatus = Boolean(
    state.retry || running.length > 0 || failed.length > 0,
  );

  return (
    <div className="activity">
      {hasLiveStatus ? (
        <div
          className="activity__live"
          role="status"
          aria-label="Current activity"
          aria-atomic="false"
        >
          {state.retry ? (
            <span className="chip chip--warning chip--live">
              <AlertTriangle size={12} aria-hidden />
              Retry {state.retry.attempt}/{state.retry.maxAttempts}
              {state.retry.message ? ` — ${state.retry.message}` : ""}
            </span>
          ) : null}
          {running.map((tool) => (
            <span key={tool.id} className="chip chip--info chip--live">
              <Loader2 size={12} className="spin" aria-hidden />
              {tool.name}
              {tool.detail ? ` — ${tool.detail}` : ""}
            </span>
          ))}
          {failed.map((tool) => (
            <span key={tool.id} className="chip chip--error">
              <XCircle size={12} aria-hidden />
              {tool.name} failed
            </span>
          ))}
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
}
