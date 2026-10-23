import type { SessionActionId } from "../shared/contracts";

export const SESSION_ACTION_LABELS: Record<SessionActionId, string> = {
  rename: "Rename session",
  "copy-id": "Copy session ID",
  clone: "Clone current branch",
  terminal: "Use in terminal…",
  export: "Export session…",
};

export const SESSION_ACTION_VISIBLE_COUNT = 4;

export function moveSessionAction(
  order: readonly SessionActionId[],
  id: SessionActionId,
  destination: number,
): SessionActionId[] {
  const next = order.filter((action) => action !== id);
  next.splice(destination, 0, id);
  return next;
}
