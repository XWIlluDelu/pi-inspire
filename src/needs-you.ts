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
 * Sort by urgency, then newest activity. An opened row keeps its priority
 * while selected so clearing its unseen outcome does not remove it.
 */
export function needsYouRows(
  sessions: readonly SessionSummary[],
  statuses: Readonly<Record<string, SessionRuntimeStatus>>,
  externals: Readonly<Record<string, ExternalSessionActivity>>,
  selectedId: string | null,
  retained: { id: string; reason: NeedsYouReason } | null,
): NeedsYouRow[] {
  const rows: Array<NeedsYouRow & { rank: number }> = [];
  for (const session of sessions) {
    const reason = needsYouReason(
      statuses[session.id],
      externals[session.id],
      session.id === selectedId,
    );
    if (reason) rows.push({ session, reason, rank: RANK[reason] });
    else if (retained?.id === session.id && session.id === selectedId)
      rows.push({ session, reason: null, rank: RANK[retained.reason] });
  }
  return rows
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        Date.parse(right.session.modified) - Date.parse(left.session.modified),
    )
    .map(({ session, reason }) => ({ session, reason }));
}
