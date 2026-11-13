import { useCallback, useSyncExternalStore } from "react";

/** Text-only, origin/Host-scoped drafts survive reload within this browser tab.
 * sessionStorage avoids cross-tab overwrites; attachments remain controller-owned
 * memory. Storage refusal falls back to the same in-memory switching behavior. */
const memory = new Map<string, string>();
const revisions = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const PREFIX = "inspire:composer-draft:v1:";
const START_KEY = `${PREFIX}start`;

function readDraft(key: string): string {
  const cached = memory.get(key);
  if (cached !== undefined) return cached;
  let text = "";
  try {
    text = window.sessionStorage.getItem(key) ?? "";
  } catch {
    // Storage refusal leaves this tab's in-memory draft available.
  }
  memory.set(key, text);
  return text;
}

function writeDraft(key: string, text: string): void {
  if (readDraft(key) === text) return;
  memory.set(key, text);
  try {
    if (text) window.sessionStorage.setItem(key, text);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Private-mode/quota restrictions must not interrupt typing or delivery.
  }
  for (const publish of listeners.get(key) ?? []) publish();
}

function sessionKey(sessionId: string): string {
  return `${PREFIX}session:${encodeURIComponent(sessionId)}`;
}

export function sessionDraft(sessionId: string): string {
  return readDraft(sessionKey(sessionId));
}

/** Text and material edits share one draft revision. Async editor deliveries
 * may replace only the revision that their originating action confirmed. */
export function sessionDraftRevision(sessionId: string): number {
  return revisions.get(sessionId) ?? 0;
}

export function touchSessionDraft(sessionId: string): void {
  revisions.set(sessionId, sessionDraftRevision(sessionId) + 1);
}

export function setSessionDraft(sessionId: string, text: string): void {
  if (sessionDraft(sessionId) !== text) touchSessionDraft(sessionId);
  writeDraft(sessionKey(sessionId), text);
}

export function deleteSessionDraft(sessionId: string): void {
  setSessionDraft(sessionId, "");
}

export function startDraftRevision(): number {
  return revisions.get(START_KEY) ?? 0;
}

export function setStartDraft(text: string): void {
  if (readDraft(START_KEY) !== text)
    revisions.set(START_KEY, startDraftRevision() + 1);
  writeDraft(START_KEY, text);
}

/** Each editor renders the stored draft directly. The start screen passes
 * undefined and a session passes its native id (or null while none is open). */
export function useDraftText(sessionId?: string | null): string {
  const key =
    sessionId === undefined
      ? START_KEY
      : sessionId
        ? sessionKey(sessionId)
        : null;
  const subscribe = useCallback(
    (publish: () => void) => {
      if (!key) return () => {};
      const current = listeners.get(key) ?? new Set();
      current.add(publish);
      listeners.set(key, current);
      return () => {
        current.delete(publish);
        if (!current.size) listeners.delete(key);
      };
    },
    [key],
  );
  return useSyncExternalStore(
    subscribe,
    () => (key ? readDraft(key) : ""),
    () => "",
  );
}
