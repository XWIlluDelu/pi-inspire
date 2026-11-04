import { useCallback, useLayoutEffect, useReducer, useRef } from "react";

let nextOwner = 0;
const foregroundOwnerKey = "__inspireInspectionOwner";
// Only live ownership can cover a parent; reload/Forward may expose old markers.
const activeOwners = new Set<number>();

/** Small history ownership for transient inspections, not a route or URL model.
 * Sibling views reuse their level; explicit close consumes all owned levels. */
export function useInspectionHistory(
  depth: number,
  onBack: (depth: number) => void,
  key: string,
  { background = false }: { background?: boolean } = {},
) {
  const owner = useRef(0);
  if (!owner.current) owner.current = ++nextOwner;
  const [, reconcile] = useReducer((value: number) => value + 1, 0);
  const current = useRef(0);
  const setCurrent = useCallback((depth: number) => {
    current.current = depth;
    if (depth > 0) activeOwners.add(owner.current);
    else activeOwners.delete(owner.current);
  }, []);
  const pendingTraversal = useRef<number | null>(null);
  const back = useRef(onBack);
  back.current = onBack;

  useLayoutEffect(() => {
    const id = owner.current;
    const pop = () => {
      const entry = window.history.state?.[key];
      const remaining = entry?.owner === id ? entry.depth : 0;
      const expected = pendingTraversal.current;
      pendingTraversal.current = null;
      if (expected !== null && remaining === expected) {
        // Explicit close is already reflected in the UI. A later open belongs
        // to the current render, not to the traversal that just completed.
        setCurrent(remaining);
        reconcile();
        return;
      }
      if (remaining >= current.current) {
        // A foreground inspection may have deferred a responsive parent update.
        if (background || window.history.state?.[foregroundOwnerKey] === id)
          reconcile();
        return;
      }
      setCurrent(remaining);
      back.current(remaining);
      // Async dismissal can leave a question mounted until its native reply.
      reconcile();
    };
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("popstate", pop);
      const release = () => {
        const entry = window.history.state?.[key];
        if (
          activeOwners.has(id) &&
          entry?.owner === id &&
          entry.depth > 0 &&
          window.history.state?.[foregroundOwnerKey] === id
        ) {
          // Keep shielding the parent until this asynchronous traversal ends.
          window.addEventListener("popstate", () => activeOwners.delete(id), {
            once: true,
          });
          window.history.go(-entry.depth);
        } else activeOwners.delete(id);
      };
      // Finish an existing traversal before removing any remaining levels.
      if (pendingTraversal.current !== null)
        window.addEventListener("popstate", release, { once: true });
      else release();
      pendingTraversal.current = null;
      current.current = 0;
    };
  }, [key, background, setCurrent]);

  useLayoutEffect(() => {
    const id = owner.current;
    // pushState can cancel an in-flight traversal or leave an extra Back stop.
    // Reconcile the latest requested depth only after its popstate arrives.
    if (pendingTraversal.current !== null) return;
    const foreground = window.history.state?.[foregroundOwnerKey];
    const covered = foreground !== id && activeOwners.has(foreground);
    // A responsive base stack stays below an independent foreground inspection,
    // whether resizing would add or remove its own levels.
    if (background && covered) return;
    try {
      if (depth > current.current) {
        for (let level = current.current + 1; level <= depth; level++)
          window.history.pushState(
            {
              ...window.history.state,
              [key]: { owner: id, depth: level },
              [foregroundOwnerKey]: id,
            },
            "",
          );
      } else if (depth < current.current) {
        const entry = window.history.state?.[key];
        if (entry?.owner === id) {
          // The parent marker is copied into nested entries; it does not own
          // their traversal. Keep the foreground view open until it retires.
          if (covered) return;
          pendingTraversal.current = depth;
          window.history.go(-(entry.depth - depth));
          return;
        }
      }
      setCurrent(depth);
    } catch {
      // Embedded browsers can forbid history writes. Explicit controls still work.
      setCurrent(0);
      pendingTraversal.current = null;
    }
  });
}
