import { useCallback, useLayoutEffect, useRef, useState } from "react";

type Result<Document> = { snapshot?: Document; warning?: string };
type FocusTarget = () => HTMLElement | null;
type Edit<Selection> = {
  target: Selection;
  opener: HTMLElement;
  scroll?: number;
};

const EMPTY = { snapshot: null, error: null, readFailed: false, busy: false };

/** One owner for a reviewed document, its open edit and its async publications. */
export function useConfigurationDocument<Document, Selection>({
  owner,
  active,
  unavailable,
  blockDuringRead = false,
  fallbackFocus,
}: {
  owner: string;
  active: boolean;
  unavailable: string;
  blockDuringRead?: boolean;
  fallbackFocus?: string;
}) {
  const [state, setState] = useState<{
    snapshot: Document | null;
    error: string | null;
    readFailed: boolean;
    busy: boolean;
  }>(EMPTY);
  const [edit, setEdit] = useState<Edit<Selection> | null>(null);
  const [selected, select] = useState<string>();
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const revision = useRef(0);
  const alive = useRef(false);
  const pending = useRef(false);
  const focus = useRef<AbortController | null>(null);
  const full = edit?.scroll !== undefined;
  const browseScroll = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    alive.current = true;
    setState(EMPTY);
    setEdit(null);
    select(undefined);
    setFocusTarget(null);
    return () => {
      alive.current = false;
      revision.current++;
      pending.current = false;
      focus.current?.abort();
    };
  }, [owner]);

  useLayoutEffect(() => {
    if (!active || (browseScroll.current === undefined && !full)) return;
    root.current?.closest(".settings__content")?.scrollTo({
      top: full ? 0 : (browseScroll.current ?? 0),
      behavior: "instant",
    });
    browseScroll.current = edit?.scroll;
  }, [active, full, edit?.scroll]);

  useLayoutEffect(() => {
    if (!focusTarget) return;
    setFocusTarget(null);
    if (!active || focus.current?.signal.aborted) return;
    focus.current?.abort();
    const element = focusTarget();
    const target =
      element?.isConnected &&
      !element.closest("[hidden]") &&
      !element.matches(":disabled")
        ? element
        : fallbackFocus &&
          root.current?.querySelector<HTMLElement>(fallbackFocus);
    if (target) target.focus();
  }, [active, fallbackFocus, focusTarget]);

  const claimFocus = () => {
    focus.current?.abort();
    setFocusTarget(null);
    const origin = document.activeElement;
    if (!(origin instanceof HTMLElement) || !root.current?.contains(origin))
      return null;
    const ticket = new AbortController();
    document.addEventListener(
      "focusin",
      (event) => {
        if (event.target !== origin && event.target !== document.body)
          ticket.abort();
      },
      { capture: true, signal: ticket.signal },
    );
    focus.current = ticket;
    return { origin, ticket };
  };
  const setError = (error: string | null) =>
    setState((current) => ({ ...current, error }));
  function open(target: Selection, opener: HTMLElement, full = false) {
    if (pending.current) return;
    setError(null);
    const scroll = full
      ? (root.current?.closest(".settings__content")?.scrollTop ?? 0)
      : undefined;
    browseScroll.current = scroll;
    setEdit({
      target,
      opener,
      scroll,
    });
  }
  function dismiss() {
    if (pending.current) return;
    if (edit && claimFocus()) setFocusTarget(() => () => edit.opener);
    setError(null);
    setEdit(null);
  }
  const observe = useCallback(
    async (
      phase: "read" | "write",
      request: () => Promise<Result<Document>>,
      complete?: (result: Result<Document> | null) => void,
      readBack?: () => Promise<Document>,
    ) => {
      if (!alive.current || pending.current) return null;
      const version = ++revision.current;
      const current = () => alive.current && version === revision.current;
      const blocks = phase === "write" || blockDuringRead;
      if (blocks) {
        pending.current = true;
        setState((previous) => ({ ...previous, busy: true, error: null }));
      }
      let result: Result<Document> | null = null;
      try {
        let next = await request();
        if (!current()) return null;
        if (!next.snapshot && readBack) {
          try {
            next = { snapshot: await readBack() };
          } catch {
            // The write is already committed.
          }
          if (!current()) return null;
        }
        setState((previous) => ({
          snapshot: next.snapshot ?? previous.snapshot,
          readFailed: !next.snapshot,
          error: next.warning ?? null,
          busy: false,
        }));
        result = next;
      } catch (error) {
        if (current())
          setState((previous) => ({
            ...previous,
            busy: false,
            readFailed: phase === "read" || previous.readFailed,
            error: error instanceof Error ? error.message : unavailable,
          }));
      }
      if (current()) {
        if (blocks) pending.current = false;
        complete?.(result);
      }
      return result;
    },
    [owner, blockDuringRead, unavailable],
  );

  const load = useCallback(
    (read: () => Promise<Document>) =>
      observe("read", async () => ({ snapshot: await read() })),
    [observe],
  );
  async function write(
    request: () => Promise<Result<Document>>,
    options: {
      close?: boolean;
      readBack?: () => Promise<Document>;
      onSaved?: (next: Result<Document>) => FocusTarget | void;
      onError?: FocusTarget;
    } = {},
  ) {
    if (!alive.current || pending.current) return false;
    const claimed = claimFocus();
    const result = await observe("write", request, (next) => {
      const nextFocus = next ? options.onSaved?.(next) : undefined;
      if (next && options.close) setEdit(null);
      if (claimed && focus.current === claimed.ticket)
        setFocusTarget(() =>
          next
            ? (nextFocus ??
              (() => (options.close ? (edit?.opener ?? null) : claimed.origin)))
            : () => options.onError?.() ?? claimed.origin,
        );
    }, options.readBack);
    return Boolean(result);
  }

  return {
    ...state,
    root,
    alive,
    edit: edit?.target ?? null,
    selected,
    select,
    browsing: !full,
    updateEdit: (target: Selection) =>
      setEdit((old) => old && { ...old, target }),
    open,
    dismiss,
    load,
    write,
    setError,
  };
}
