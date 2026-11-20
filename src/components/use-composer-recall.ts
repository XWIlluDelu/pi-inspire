import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ComposerHistoryEntry } from "../../shared/contracts";
import {
  type ComposerHistoryScope,
  recentComposerHistory,
} from "../composer-history";
import { recalledInputAttachments } from "../controllers/composer-controller";
import type { SessionDraft } from "../session-drafts";
import { store } from "../store";
import { isTextareaCaretOnVisualEdge } from "../textarea-caret";

type Selection = Pick<
  HTMLTextAreaElement,
  "selectionStart" | "selectionEnd" | "selectionDirection" | "scrollTop"
>;
type Browsing = {
  key: string;
  revision: number;
  entries: readonly ComposerHistoryEntry[];
  index: number;
  selection: Selection;
};

function recallEntries(
  recent: readonly ComposerHistoryEntry[],
  saved: readonly ComposerHistoryEntry[],
): readonly ComposerHistoryEntry[] {
  // The native reader may already include the newest locally accepted sends.
  const same = (a: ComposerHistoryEntry, b: ComposerHistoryEntry) =>
    a.text === b.text &&
    JSON.stringify(a.images) === JSON.stringify(b.images) &&
    JSON.stringify(a.files) === JSON.stringify(b.files);
  let overlap = Math.min(recent.length, saved.length);
  while (
    overlap &&
    !recent.slice(-overlap).every((entry, i) => same(entry, saved[i]!))
  )
    overlap -= 1;
  return [...recent.slice(0, recent.length - overlap), ...saved];
}

export function useComposerRecall(
  scope: ComposerHistoryScope | null,
  key: string | null,
  draft: SessionDraft,
  opening: boolean,
) {
  const [history, setHistory] = useState<{
    key: string;
    entries: ComposerHistoryEntry[] | null;
  }>();
  const [browsing, setBrowsing] = useState<Browsing | null>(null);
  const pendingSelection = useRef<{
    input: HTMLTextAreaElement;
    selection: Selection;
  } | null>(null);
  const { sessionId, viewId, incarnation, historyVersion } = scope ?? {};
  useEffect(() => {
    if (!key || !sessionId || !viewId || !historyVersion) return;
    const read = new AbortController();
    void store.branches
      .composerHistory(
        { sessionId, viewId, incarnation: incarnation ?? null, historyVersion },
        read.signal,
      )
      .then((entries) => {
        if (!read.signal.aborted) setHistory({ key, entries });
      });
    return () => read.abort();
  }, [historyVersion, incarnation, key, sessionId, viewId]);

  useEffect(() => {
    setBrowsing(null);
  }, [key, opening, draft.revision]);

  const recent = scope ? recentComposerHistory(scope) : [];
  const saved = history?.key === key ? history?.entries : undefined;
  const active =
    !opening &&
    browsing &&
    browsing.key === key &&
    browsing.revision === draft.revision
      ? browsing
      : null;
  const entry = active?.entries[active.index];
  const displayed =
    entry && scope
      ? {
          ...draft,
          text: entry.text,
          attachments: recalledInputAttachments(scope, entry),
          projectFiles: [],
          intentId: undefined,
        }
      : draft;

  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    if (!pending) return;
    pendingSelection.current = null;
    const { input, selection } = pending;
    if (document.activeElement !== input) return;
    input.setSelectionRange(
      selection.selectionStart,
      selection.selectionEnd,
      selection.selectionDirection,
    );
    input.scrollTop = selection.scrollTop;
  });

  const select = (
    input: HTMLTextAreaElement,
    next: Browsing | null,
    selection: Selection,
  ) => {
    pendingSelection.current = { input, selection };
    setBrowsing(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      !scope ||
      !key ||
      opening ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const input = event.currentTarget;
    if (input.selectionStart !== input.selectionEnd) return;
    const earlier = event.key === "ArrowUp";
    if (!earlier && event.key !== "ArrowDown") return;
    const entries = active?.entries ?? recallEntries(recent, saved ?? []);
    if (
      !entries.length ||
      !isTextareaCaretOnVisualEdge(input, earlier ? "first" : "last")
    )
      return;
    const caret = input.selectionStart;
    event.preventDefault();
    if (!active) {
      const start =
        caret === 0 ? 0 : input.value.lastIndexOf("\n", caret - 1) + 1;
      const end = input.value.indexOf("\n", caret);
      const edge = earlier ? start : end === -1 ? input.value.length : end;
      if (!earlier || caret !== edge) {
        input.setSelectionRange(edge, edge);
        return;
      }
    }
    const index = Math.min(
      (active?.index ?? -1) + (earlier ? 1 : -1),
      entries.length - 1,
    );
    if (index < 0) {
      if (active) select(input, null, active.selection);
      return;
    }
    const selection = active?.selection ?? {
      selectionStart: caret,
      selectionEnd: caret,
      selectionDirection: input.selectionDirection,
      scrollTop: input.scrollTop,
    };
    const cursor = earlier ? 0 : entries[index]!.text.length;
    select(
      input,
      { key, revision: draft.revision, entries, index, selection },
      {
        selectionStart: cursor,
        selectionEnd: cursor,
        selectionDirection: "none",
        scrollTop: earlier ? 0 : Number.MAX_SAFE_INTEGER,
      },
    );
  };

  return {
    displayed,
    onKeyDown,
    apply: () => {
      if (!entry || !scope) return true;
      const applied = store.useComposerHistoryEntry(
        scope,
        entry,
        draft.revision,
      );
      setBrowsing(null);
      return applied;
    },
  };
}
