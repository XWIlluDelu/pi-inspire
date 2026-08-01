import { resolve } from "node:path";
import type { ActiveSnapshot } from "../shared/contracts.js";
import type { SessionRecord } from "./session-catalog.js";
import { SessionProjection } from "./session-projection.js";

export type ActiveSessionSnapshot = NonNullable<ActiveSnapshot["active"]>;

/** One-shot compatibility facade over the sole Pi JSONL parser authority. */
export async function loadSessionPreview(session: SessionRecord): Promise<ActiveSessionSnapshot> {
  const projection = await SessionProjection.open(session);
  try {
    const page = projection.latestPage();
    return {
      sessionId: session.id,
      sessionFile: resolve(session.path),
      sessionName: session.name,
      cwd: resolve(session.cwd || process.cwd()),
      model: projection.model,
      thinkingLevel: projection.thinkingLevel,
      isStreaming: false,
      isCompacting: false,
      messages: page.messages,
      transcriptPage: page,
      projectionHealth: projection.health,
      availableModels: [],
      commands: [],
    };
  } finally {
    await projection.close();
  }
}
