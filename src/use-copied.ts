import { useEffect, useRef, useState } from "react";

/** Clipboard write with a transient "copied" confirmation. Repeat copies
 * restart the confirmation window; unmount clears the pending timer. */
export function useCopied(timeoutMs = 1_500): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), timeoutMs);
    } catch {
      // clipboard unavailable (permissions); leave state unchanged
    }
  };

  return { copied, copy };
}
