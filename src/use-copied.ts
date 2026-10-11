import { useEffect, useRef, useState } from "react";
import {
  type CopyLoader,
  type CopySource,
  writeCopyContent,
} from "./content-copy";

/** One owned copy operation and a transient confirmation, retired on unmount. */
export function useCopied({
  timeoutMs = 1_500,
  onError,
}: {
  timeoutMs?: number;
  onError?: (message: string) => void;
} = {}) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      request.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (
    source: CopySource | CopyLoader,
    isCurrent: () => boolean = () => true,
  ) => {
    request.current?.abort();
    const owner = new AbortController();
    request.current = owner;
    const current = () => !owner.signal.aborted && isCurrent();
    if (timer.current) clearTimeout(timer.current);
    setCopied(false);
    setCopying(true);
    try {
      const content =
        typeof source === "function" ? await source(owner.signal) : source;
      if (content === null || !current()) return;
      if (await writeCopyContent(content, current)) {
        setCopied(true);
        timer.current = setTimeout(() => setCopied(false), timeoutMs);
      }
    } catch (error) {
      if (current())
        onError?.(
          error instanceof Error ? error.message : "Clipboard write failed",
        );
    } finally {
      if (request.current === owner && !owner.signal.aborted) setCopying(false);
    }
  };

  return { copied, copying, copy };
}
