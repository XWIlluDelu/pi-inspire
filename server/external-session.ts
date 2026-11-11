import type {
  AttachControlState,
  ImageReference as NativeImageReference,
  ModelCatalog as NativeModelCatalog,
  ModelSelection as NativeModelSelection,
} from "../extensions/attach-control.js";

export const PI_STATE_OBSERVATION_TIMEOUT_MS = 1_500;

export type ExternalSessionState = Pick<
  AttachControlState,
  "activity" | "leafId" | "modelSelection" | "taskRuns" | "uiRequests"
>;

/** Why Inspire stopped following an attached Pi. Only "exited" is evidence
 * about the process; none establishes the outcome of a task it was running. */
export type AttachmentEnd =
  | "exited"
  | "left-session"
  | "left-branch"
  | "unreachable";

export type ExternalSessionRead =
  | ExternalSessionState
  | { ended: Exclude<AttachmentEnd, "left-branch"> };

/** One Pi session binding. Each command opens and closes its own socket. */
export interface ExternalSessionConnection {
  /** `ended` finishes the attachment; a rejection is transient (such as a
   * reload) until it outlasts the grace period and becomes "unreachable". */
  read(timeoutMs?: number): Promise<ExternalSessionRead>;
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
}

export type MatchExternalLeaf = (
  leafId: string | null,
) => "continues" | "possible" | "other";

/** Select a live Pi to verify before attaching. */
export type ConnectExternalSession = (
  sessionId: string,
  sessionFile: string,
  match: MatchExternalLeaf,
  idleOnly: boolean,
) => Promise<ExternalSessionConnection | null>;

/** A missing leaf means the live position could not be verified. */
export type ReadExternalLeaves = (
  sessionId: string,
  sessionFile: string,
  fresh: boolean,
  isAncestor: (leafId: string | null) => boolean,
) => Promise<(string | null | undefined)[]>;
