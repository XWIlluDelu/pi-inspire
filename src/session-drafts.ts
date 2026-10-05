/** Text-only, origin/Host-scoped drafts survive reload within this browser tab.
 * sessionStorage avoids cross-tab overwrites; attachments remain controller-owned
 * memory. Storage refusal falls back to the same in-memory switching behavior. */
const memory = new Map<string, string>();
const unwritten = new Set<string>();
const revisions = new Map<string, number>();
const PREFIX = "inspire:composer-draft:v1:";
const START_KEY = `${PREFIX}start`;

function readDraft(key: string): string {
  if (unwritten.has(key)) return memory.get(key) ?? "";
  try {
    const text = window.sessionStorage.getItem(key) ?? "";
    if (text) memory.set(key, text);
    else memory.delete(key);
    return text;
  } catch {
    return memory.get(key) ?? "";
  }
}

function writeDraft(key: string, text: string): void {
  if (text) memory.set(key, text);
  else memory.delete(key);
  try {
    if (text) window.sessionStorage.setItem(key, text);
    else window.sessionStorage.removeItem(key);
    unwritten.delete(key);
  } catch {
    unwritten.add(key);
    // Private-mode/quota restrictions must not interrupt typing or delivery.
  }
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

export function startDraft(): string {
  return readDraft(START_KEY);
}

export function setStartDraft(text: string): void {
  writeDraft(START_KEY, text);
}
