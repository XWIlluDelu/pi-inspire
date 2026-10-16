/** A connection to somebody else's interactive Pi, not an owned RPC worker. */
export interface ExternalSessionState {
  status: "idle" | "working" | "blocked" | "unknown";
}

export interface ExternalSessionConnection {
  read(): Promise<ExternalSessionState | null>;
  prompt(
    message: string,
    behavior?: "steer" | "followUp",
    beforeSend?: () => void,
  ): Promise<void>;
  abort(): Promise<void>;
  /** Release Host resources only; never terminate Pi or close its terminal. */
  close(): void;
}

export type ConnectExternalSession = (
  sessionId: string,
  sessionFile: string,
) => Promise<ExternalSessionConnection | null>;
