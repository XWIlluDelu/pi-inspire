import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type CopyLoader,
  type CopySource,
  writeCopyContent,
} from "./content-copy";

/** Copy feedback belongs to one source lifetime, not a reused button. */
export function useCopied({
  timeoutMs = 1_500,
  onError,
  scope,
}: {
  timeoutMs?: number;
  onError?: (message: string) => void;
  scope?: string | null;
} = {}) {
  // A -> B -> A must not revive A's retired confirmation or request.
  const lifetime = useMemo(() => ({ scope }), [scope]);
  const currentLifetime = useRef(lifetime);
  const [status, setStatus] = useState({
    lifetime,
    copied: false,
    copying: false,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    currentLifetime.current = lifetime;
    return () => {
      request.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [lifetime]);

  const copy = async (
    source: CopySource | CopyLoader,
    isCurrent: () => boolean = () => true,
  ) => {
    request.current?.abort();
    const owner = new AbortController();
    request.current = owner;
    const current = () =>
      !owner.signal.aborted &&
      currentLifetime.current === lifetime &&
      isCurrent();
    if (timer.current) clearTimeout(timer.current);
    setStatus({ lifetime, copied: false, copying: true });
    try {
      if (
        (await writeCopyContent(source, current, owner.signal)) &&
        current()
      ) {
        setStatus({ lifetime, copied: true, copying: false });
        timer.current = setTimeout(
          () =>
            setStatus((status) =>
              status.lifetime === lifetime
                ? { ...status, copied: false }
                : status,
            ),
          timeoutMs,
        );
      }
    } catch (error) {
      if (current())
        onError?.(
          error instanceof Error ? error.message : "Clipboard write failed",
        );
    } finally {
      if (request.current === owner && !owner.signal.aborted)
        setStatus((status) =>
          status.lifetime === lifetime ? { ...status, copying: false } : status,
        );
    }
  };

  return {
    copied: status.lifetime === lifetime && status.copied,
    copying: status.lifetime === lifetime && status.copying,
    copy,
  };
}
