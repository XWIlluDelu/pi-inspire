import type { SessionRuntimeStatus, SessionSummary } from "../shared/contracts";
import type { ExternalSessionActivity } from "../shared/session-activity";
import { presentSessionActivity } from "./session-activity-presentation";

/** Why a session is waiting on the person, most urgent first. */
export type NeedsYouReason = "attention" | "failed" | "completed";

const RANK: Record<NeedsYouReason, number> = {
  attention: 0,
  failed: 1,
  completed: 2,
};

/**
 * A session needs you when Pi is waiting for input or recovery, or when a run
 * failed or finished and you have not looked yet. Running work does not: it
 * needs nothing until it stops. Viewing a session clears its unseen outcome,
 * the same rule the row's status mark follows.
 */
export function needsYouReason(
  status: SessionRuntimeStatus | undefined,
  external: ExternalSessionActivity | undefined,
  selected: boolean,
): NeedsYouReason | null {
  const { indicator } = presentSessionActivity(status, external);
  if (indicator === "attention") return "attention";
  if (selected) return null;
  return indicator === "failed" || indicator === "completed" ? indicator : null;
}

interface NeedsYouRow {
  session: SessionSummary;
  reason: NeedsYouReason | null;
}

/**
 * The Needs you list: urgent first, then the catalog's recency order. The
 * session you just opened from this list stays in its place while it is open
 * (`retained`), so the row you clicked does not vanish under the pointer.
 */
export function needsYouRows(
  sessions: readonly SessionSummary[],
  statuses: Readonly<Record<string, SessionRuntimeStatus>>,
  externals: Readonly<Record<string, ExternalSessionActivity>>,
  selectedId: string | null,
  retained: { id: string; reason: NeedsYouReason } | null,
): NeedsYouRow[] {
  const rows: Array<NeedsYouRow & { rank: number; order: number }> = [];
  sessions.forEach((session, order) => {
    const reason = needsYouReason(
      statuses[session.id],
      externals[session.id],
      session.id === selectedId,
    );
    if (reason) rows.push({ session, reason, rank: RANK[reason], order });
    else if (retained?.id === session.id && session.id === selectedId)
      rows.push({ session, reason: null, rank: RANK[retained.reason], order });
  });
  return rows
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .map(({ session, reason }) => ({ session, reason }));
}
