import type { SessionActionId } from "../shared/contracts";

export const sessionActions = {
  rename: { title: "Rename session", command: "name" },
  "copy-id": { title: "Copy session ID" },
  clone: { title: "Clone current branch", command: "clone" },
  "switch-branch": { title: "Switch branch…", command: "tree" },
  export: { title: "Export session…", command: "export" },
} as const satisfies Record<
  SessionActionId,
  { title: string; command?: string }
>;

export function moveSessionAction(
  order: readonly SessionActionId[],
  id: SessionActionId,
  destination: number,
): SessionActionId[] {
  const next = order.filter((action) => action !== id);
  next.splice(destination, 0, id);
  return next;
}
