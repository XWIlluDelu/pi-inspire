import type { ActiveSnapshot } from "../shared/contracts.js";
import type { SessionRecord } from "./session-catalog.js";
import type { SessionProjectionView } from "./session-projection.js";

export type ActiveSessionSnapshot = NonNullable<ActiveSnapshot["active"]>;

export function sessionProjectionSnapshot(
  session: SessionRecord,
  projection: SessionProjectionView,
  cwd: string,
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
    commands: [],
  };
}
