import type { SessionSummary } from "../../../shared/contracts";

// Keep the server cursor/count independent of rendered or curated identities.
export function sessionPage(
  sessions: SessionSummary[],
  total: number,
  offset = 0,
  limit = 40,
) {
  return { sessions, total, offset, limit };
}
