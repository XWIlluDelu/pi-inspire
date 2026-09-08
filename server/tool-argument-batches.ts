import type { ToolArgumentUpdate } from "../shared/tool-argument-updates.js";

/** Collapse adjacent updates to one tool inside the existing 16ms socket
 * batch. Keep the source event count on the envelope for revision continuity. */
export function compactToolArgumentEvents(events: unknown[]): unknown[] {
  const compact: unknown[] = [];
  for (const value of events) {
    const next = value as Record<string, unknown> | null;
    const previous = compact.at(-1) as Record<string, unknown> | undefined;
    if (
      next?.type !== "toolcall_delta" ||
      previous?.type !== "toolcall_delta" ||
      next.contentIndex !== previous.contentIndex ||
      !Array.isArray(next.argumentUpdates) ||
      !Array.isArray(previous.argumentUpdates)
    ) {
      compact.push(value);
      continue;
    }
    const updates = [...previous.argumentUpdates] as ToolArgumentUpdate[];
    for (const update of next.argumentUpdates as ToolArgumentUpdate[]) {
      const last = updates.at(-1);
      const samePath =
        last &&
        last.path.length === update.path.length &&
        last.path.every((key, index) => key === update.path[index]);
      if (
        samePath &&
        "append" in update &&
        ("append" in last || typeof last.set === "string")
      ) {
        updates[updates.length - 1] =
          "append" in last
            ? { ...last, append: last.append + update.append }
            : { ...last, set: String(last.set) + update.append };
      } else updates.push(update);
    }
    // Do not create an argument update beyond the shared reducer's bound.
    if (updates.length > 1_024) compact.push(value);
    else compact[compact.length - 1] = { ...next, argumentUpdates: updates };
  }
  return compact;
}
