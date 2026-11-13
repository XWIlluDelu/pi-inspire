import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Reset observations on owner changes; native login keeps its own lifetime. */
export function useConfigurationDocument<Document>(
  owner: string,
  unavailable: string,
  blockDuringRead = false,
) {
  const [snapshot, setSnapshot] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState<"read" | "write" | null>(null);
  const revision = useRef(0);
  const alive = useRef(false);
  const pending = useRef<"read" | "write" | null>(null);
  useLayoutEffect(() => {
    alive.current = true;
    setSnapshot(null);
    setError(null);
    setReadFailed(false);
    setBusy(null);
    return () => {
      alive.current = false;
      revision.current++;
      pending.current = null;
    };
  }, [owner]);
  const observe = useCallback(
    async (
      phase: "read" | "write",
      request: () => Promise<{ snapshot?: Document; warning?: string }>,
    ) => {
      if (!alive.current || pending.current) return null;
      const version = ++revision.current;
      const current = () => alive.current && version === revision.current;
      if (phase === "write" || blockDuringRead) {
        pending.current = phase;
        setBusy(phase);
        setError(null);
      }
      try {
        const next = await request();
        if (!current()) return null;
        if (next.snapshot) setSnapshot(next.snapshot);
        setReadFailed(!next.snapshot);
        setError(next.warning ?? null);
        return { ...next, version };
      } catch (error) {
        if (current()) {
          if (phase === "read") setReadFailed(true);
          setError(error instanceof Error ? error.message : unavailable);
        }
        return null;
      } finally {
        if (current() && pending.current) {
          pending.current = null;
          setBusy(null);
        }
      }
    },
    [owner, blockDuringRead, unavailable],
  );
  const load = useCallback(
    async (read: () => Promise<Document>) =>
      (await observe("read", async () => ({ snapshot: await read() })))
        ?.version ?? null,
    [observe],
  );
  return {
    snapshot,
    error,
    setError,
    busy: busy !== null,
    readFailed,
    revision,
    alive,
    load,
    write: (
      request: () => Promise<{ snapshot?: Document; warning?: string }>,
    ) => observe("write", request),
  };
}
