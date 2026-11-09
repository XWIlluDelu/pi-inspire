import type {
  ImageReference as NativeImageReference,
  ModelCatalog as NativeModelCatalog,
  ModelSelection as NativeModelSelection,
  TaskRuns as NativeTaskRuns,
} from "../extensions/attach-control.js";

/** A connection to an externally owned Pi, not an Inspire-owned worker. */
export interface ExternalSessionState {
  status: "idle" | "working" | "blocked" | "unknown";
  taskRuns?: NativeTaskRuns;
  modelSelection?: NativeModelSelection;
  outcome?: "failed";
  /** The attached Pi's current branch leaf. */
  leafId?: string | null;
  uiRequests?: Record<string, unknown>[];
}

/** Why Inspire stopped following an attached Pi. Only "exited" is evidence
 * about the process; none establishes the outcome of a task it was running. */
export type AttachmentEnd =
  | "exited"
  | "left-session"
  | "left-branch"
  | "unreachable";

export interface ExternalSessionConnection {
  /** `ended` finishes the attachment; a rejection is transient (such as a
   * reload) until it outlasts the grace period and becomes "unreachable". */
  read(): Promise<
    ExternalSessionState | { ended: Exclude<AttachmentEnd, "left-branch"> }
  >;
  prompt(
    message: string,
    behavior?: "steer" | "followUp",
    beforeSend?: () => void,
    images?: NativeImageReference[],
    expectedLeafId?: string | null,
  ): Promise<void>;
  /** Interrupts agent work, not native TUI shell execution. */
  abort(expectedLeafId?: string | null): Promise<void>;
  answerUi(response: Record<string, unknown>): Promise<void>;
  rename(name: string, beforeSend?: () => void): Promise<void>;
  models(): Promise<NativeModelCatalog>;
  setModel(
    provider: string,
    modelId: string,
    beforeSend?: () => void,
  ): Promise<NativeModelSelection>;
  setThinkingLevel(
    level: NativeModelCatalog["thinkingLevel"],
    beforeSend?: () => void,
  ): Promise<NativeModelSelection>;
  /** Reload settings, extensions and resources in the attached Pi. */
  reload(): Promise<void>;
  /** Release Host resources only; never terminate Pi or close its terminal. */
  close(): void;
}

/** Attach to the preferred live Pi whose leaf `accepts`; null when none
 * remains. Called only for an explicit takeover. */
export type ConnectExternalSession = (
  sessionId: string,
  sessionFile: string,
  accepts: (leafId: string | null) => boolean,
) => Promise<ExternalSessionConnection | null>;
