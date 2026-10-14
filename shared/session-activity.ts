import {
  isBusyRunState,
  MAX_SESSION_ID_CHARS,
  type SessionRuntimeStatus,
} from "./contracts.js";

/** Observations only: these sessions are not Inspire-owned workers. */
export type ExternalSessionActivity = "working" | "idle" | "blocked";
export type ExternalSessionActivities = Record<string, ExternalSessionActivity>;

export function isExternalSessionActivities(
  value: unknown,
): value is ExternalSessionActivities {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.entries(value).every(
        ([id, activity]) =>
          id.length > 0 &&
          id.length <= MAX_SESSION_ID_CHARS &&
          (activity === "working" ||
            activity === "idle" ||
            activity === "blocked"),
      ),
  );
}

/** Count identities, not panes/processes; waiting for input is not active work. */
export function countBusySessions(
  managed: Readonly<Record<string, SessionRuntimeStatus>>,
  external: Readonly<ExternalSessionActivities>,
): number {
  const busy = new Set(
    Object.entries(managed)
      .filter(
        ([, status]) => isBusyRunState(status.runState) && !status.needsInput,
      )
      .map(([id]) => id),
  );
  for (const [id, activity] of Object.entries(external))
    if (activity === "working") busy.add(id);
  return busy.size;
}
