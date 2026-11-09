import type { SessionRuntimeStatus } from "../shared/contracts";

interface SessionControlsState {
  sessionId: string | null;
  sessionStatuses: Record<string, SessionRuntimeStatus>;
}

export function isExternalSession(state: SessionControlsState): boolean {
  return Boolean(
    state.sessionId && state.sessionStatuses[state.sessionId]?.external,
  );
}

/** Owned workers and attached terminal Pi both take model and thinking
 * changes; an unreachable terminal Pi reports that when a change is sent. */
export function modelControlsSupported(state: SessionControlsState): boolean {
  return Boolean(state.sessionId);
}
