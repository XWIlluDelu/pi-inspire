/** Unsent composer text is intentionally in-memory and partitioned by Pi
 * session identity. Deletion can retire the same partition without importing
 * a React component into the application store. */
const sessionDrafts = new Map<string, string>();

export function sessionDraft(sessionId: string): string {
  return sessionDrafts.get(sessionId) ?? "";
}

export function setSessionDraft(sessionId: string, text: string): void {
  if (text) sessionDrafts.set(sessionId, text);
  else sessionDrafts.delete(sessionId);
}

export function deleteSessionDraft(sessionId: string): void {
  sessionDrafts.delete(sessionId);
}
