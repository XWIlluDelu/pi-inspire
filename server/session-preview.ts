import { resolve } from "node:path";
import type { ActiveSnapshot } from "../shared/contracts.js";
import type { SessionRecord } from "./session-catalog.js";
import {
  SessionProjection,
  type SessionProjectionView,
} from "./session-projection.js";

export type ActiveSessionSnapshot = NonNullable<ActiveSnapshot["active"]>;

export function sessionProjectionSnapshot(
  session: SessionRecord,
  projection: SessionProjectionView,
  cwd = resolve(session.cwd),
): ActiveSessionSnapshot {
  return {
    sessionId: session.id,
    sessionFile: projection.path,
    sessionName: session.name,
    cwd,
    model: projection.model,
    thinkingLevel: projection.thinkingLevel,
    isStreaming: false,
    isCompacting: false,
    transcriptPage: projection.latestPage(),
    projectionHealth: projection.health,
    availableModels: [],
    commands: [],
  };
}

/** One-shot preview adapter over the sole Pi JSONL parser authority. */
export async function loadSessionPreview(
  session: SessionRecord,
): Promise<ActiveSessionSnapshot> {
  const projection = await SessionProjection.open(session);
  try {
    return sessionProjectionSnapshot(session, projection);
  } finally {
    await projection.close();
  }
}
