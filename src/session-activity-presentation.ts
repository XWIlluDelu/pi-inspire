import {
  isBusyRunState,
  type SessionIndicator,
  type SessionRuntimeStatus,
} from "../shared/contracts";
import type { ExternalSessionActivity } from "../shared/session-activity";

const labels: Record<SessionIndicator, string> = {
  running: "Working",
  completed: "Completed",
  failed: "Failed",
  attention: "Needs recovery",
};

/** Navigation's observational status; input-blocked work is not an animated busy cue. */
export function presentSessionActivity(
  status: SessionRuntimeStatus | undefined,
  externalActivity: ExternalSessionActivity | undefined,
) {
  const conflicted = status?.runState === "conflict";
  const managedBusy = status ? isBusyRunState(status.runState) : false;
  const external = !managedBusy && !conflicted ? externalActivity : undefined;
  const indicator: SessionIndicator | undefined =
    status?.needsInput && !conflicted
      ? "attention"
      : external === "working"
        ? "running"
        : external === "blocked"
          ? "attention"
          : external === "idle"
            ? undefined
            : status?.indicator;
  const externalLabel =
    external === "working"
      ? "Working in Pi"
      : external === "blocked"
        ? "Waiting for input in Pi"
        : external === "idle"
          ? "Idle in Pi"
          : null;
  return {
    indicator,
    externalLabel,
    conflicted,
    label:
      status?.needsInput && !conflicted
        ? "Waiting for input"
        : (externalLabel ?? (indicator ? labels[indicator] : null)),
  };
}
