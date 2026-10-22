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
  const back = useRef(onBack);
  back.current = onBack;

  useLayoutEffect(() => {
    const id = owner.current;
    const pop = () => {
      const entry = window.history.state?.[key];
      const remaining = entry?.owner === id ? entry.depth : 0;
      if (remaining >= current.current) return;
      current.current = remaining;
      back.current(remaining);
      // Async dismissal can leave a question mounted until its native reply.
      reconcile();
    };
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("popstate", pop);
      const entry = window.history.state?.[key];
      if (entry?.owner === id && current.current > 0)
        window.history.go(-current.current);
      current.current = 0;
    };
  }, [key]);

  useLayoutEffect(() => {
    const id = owner.current;
    try {
      if (depth > current.current) {
        for (let level = current.current + 1; level <= depth; level++)
          window.history.pushState(
            { ...window.history.state, [key]: { owner: id, depth: level } },
            "",
          );
      } else if (depth < current.current) {
        const entry = window.history.state?.[key];
        if (entry?.owner === id) window.history.go(-(entry.depth - depth));
      }
      current.current = depth;
    } catch {
      // Embedded browsers can forbid history writes. Explicit controls still work.
      current.current = 0;
    }
  });
}
