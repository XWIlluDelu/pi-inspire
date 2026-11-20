import { z } from "zod";

export const CHECKPOINT_SUFFIX = "_checkpoint";
export const NATIVE_START_SUFFIX = "_native_start";
export const CHECKPOINT_CHUNK_CHARS = 64 * 1024;
export const CHECKPOINT_MAX_CHARS = 64 * 1024 * 1024;
export const CHECKPOINT_MAX_ENTRIES = 10_000;

const cursor = z.string().min(1).max(200).nullable();
export const workerCheckpoint = z.object({
  workerId: z.string(),
  contextGeneration: z.int().positive(),
  sessionId: z.string(),
  sessionFile: z.string().nullable(),
  from: cursor,
  tail: cursor,
  leaf: cursor,
  sealed: z.boolean(),
  entries: z.int().min(0).max(CHECKPOINT_MAX_ENTRIES),
});
export type WorkerCheckpoint = z.infer<typeof workerCheckpoint>;
