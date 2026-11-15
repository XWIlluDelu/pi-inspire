export const CHECKPOINT_SUFFIX = "_checkpoint";
export const NATIVE_START_SUFFIX = "_native_start";
export const CHECKPOINT_CHUNK_CHARS = 64 * 1024;
export const CHECKPOINT_MAX_CHARS = 64 * 1024 * 1024;
export const CHECKPOINT_MAX_ENTRIES = 10_000;

export interface WorkerCheckpoint {
  workerId: string;
  contextGeneration: number;
  sessionId: string;
  sessionFile: string | null;
  from: string | null;
  tail: string | null;
  leaf: string | null;
  run: number;
  sealed: "turn" | "settled" | "idle" | null;
  entries: number;
}
