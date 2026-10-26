import { useLayoutEffect, useReducer, useRef } from "react";

let nextOwner = 0;

/** Small history ownership for transient inspections, not a route or URL model.
 * Sibling views reuse their level; explicit close consumes all owned levels. */
export function useInspectionHistory(
  depth: number,
  onBack: (depth: number) => void,
  key: string,
) {
  const owner = useRef(0);
  if (!owner.current) owner.current = ++nextOwner;
  const [, reconcile] = useReducer((value: number) => value + 1, 0);
  const current = useRef(0);
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
        current.current = remaining;
        reconcile();
        return;
      }
      if (remaining >= current.current) return;
      current.current = remaining;
      back.current(remaining);
      // Async dismissal can leave a question mounted until its native reply.
      reconcile();
    };
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("popstate", pop);
      const release = () => {
        const entry = window.history.state?.[key];
        if (entry?.owner === id && entry.depth > 0)
          window.history.go(-entry.depth);
      };
      // Finish an existing traversal before removing any remaining levels.
      if (pendingTraversal.current !== null)
        window.addEventListener("popstate", release, { once: true });
      else release();
      pendingTraversal.current = null;
      current.current = 0;
    };
  }, [key]);

  useLayoutEffect(() => {
    const id = owner.current;
    // pushState can cancel an in-flight traversal or leave an extra Back stop.
    // Reconcile the latest requested depth only after its popstate arrives.
    if (pendingTraversal.current !== null) return;
    try {
      if (depth > current.current) {
        for (let level = current.current + 1; level <= depth; level++)
          window.history.pushState(
            { ...window.history.state, [key]: { owner: id, depth: level } },
            "",
          );
      } else if (depth < current.current) {
        const entry = window.history.state?.[key];
        if (entry?.owner === id) {
          pendingTraversal.current = depth;
          window.history.go(-(entry.depth - depth));
          return;
        }
      }
      current.current = depth;
    } catch {
      // Embedded browsers can forbid history writes. Explicit controls still work.
      current.current = 0;
      pendingTraversal.current = null;
    }
  });
}
