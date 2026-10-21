/** A connection to an externally owned Pi, not an Inspire-owned worker. */
export interface ExternalSessionState {
  status: "idle" | "working" | "blocked" | "unknown";
}

export interface ExternalSessionConnection {
  /** A target extension may interrupt agent work but not native TUI shell execution. */
  readonly interruptionScope?: "agent";
  /** null means this owner is confirmed no longer writing this session.
   * An unavailable endpoint or uncertain ownership MUST reject, never return null. */
  read(): Promise<ExternalSessionState | null>;
  prompt(
    message: string,
    behavior?: "steer" | "followUp",
    beforeSend?: () => void,
  ): Promise<void>;
  abort(): Promise<void>;
  rename?(name: string, beforeSend?: () => void): Promise<void>;
  /** Release Host resources only; never terminate Pi or close its terminal. */
  close(): void;
}

/** null means the connector does not claim this session. Errors veto local
 * startup. A connector claiming a scope must retain that claim across outages. */
export type ConnectExternalSession = (
  sessionId: string,
  sessionFile: string,
) => Promise<ExternalSessionConnection | null>;
