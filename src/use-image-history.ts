import { useCallback, useLayoutEffect, useRef } from "react";

const HISTORY_KEY = "__inspireImagePreview";
let nextEntry = 0;

/** The owner stays mounted while closed, so StrictMode's mount replay cannot
 * push two entries. Gallery changes reuse the same entry; Back closes one
 * inspection, not the conversation. Never replace the application's state. */
export function useImageHistory(open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  const entry = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const id = ++nextEntry;
    const pop = () => {
      if (window.history.state?.[HISTORY_KEY] !== id) {
        entry.current = null;
        close.current();
      }
    };
    try {
      window.history.pushState(
        { ...window.history.state, [HISTORY_KEY]: id },
        "",
      );
      entry.current = id;
      window.addEventListener("popstate", pop);
    } catch {
      // Embedded browsers may disallow history writes; explicit close still works.
      return;
    }
    return () => {
      window.removeEventListener("popstate", pop);
      entry.current = null;
      if (window.history.state?.[HISTORY_KEY] === id) window.history.back();
    };
  }, [open]);

  return useCallback(() => {
    if (
      entry.current !== null &&
      window.history.state?.[HISTORY_KEY] === entry.current
    )
      window.history.back();
    else close.current();
  }, []);
}
