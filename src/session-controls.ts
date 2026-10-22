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

export function modelControlsSupported(state: SessionControlsState): boolean {
  return Boolean(
    state.sessionId &&
      (!isExternalSession(state) ||
        state.sessionStatuses[state.sessionId]?.nativeModelControls === true),
  );
}

export const NATIVE_MODEL_GUIDANCE =
  "Load the updated session-activity extension with /reload in the original Pi terminal, then reselect this session.";
