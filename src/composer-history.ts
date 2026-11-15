import type { ComposerHistoryEntry } from "../shared/contracts";

export interface ComposerHistoryScope {
  sessionId: string;
  viewId: string;
  incarnation: string | null;
  effectiveLeafId: string | null;
  historyVersion: string;
}

const recent = new Map<string, ComposerHistoryEntry[]>();
const MAX_RECENT_INPUTS = 20;
const MAX_RECENT_SCOPES = 12;

export function composerHistoryScopeKey(scope: ComposerHistoryScope): string {
  return JSON.stringify([
    scope.sessionId,
    scope.viewId,
    scope.incarnation,
    scope.effectiveLeafId,
    scope.historyVersion,
  ]);
}

function recentKey(scope: ComposerHistoryScope): string {
  return JSON.stringify([scope.sessionId, scope.viewId, scope.incarnation]);
}

export function recentComposerHistory(
  scope: ComposerHistoryScope,
): readonly ComposerHistoryEntry[] {
  return recent.get(recentKey(scope)) ?? [];
}

export function rememberComposerHistory(
  scope: ComposerHistoryScope,
  entry: ComposerHistoryEntry,
): void {
  if (!entry.text.trim() && !entry.images.length && !entry.files.length) return;
  const key = recentKey(scope);
  const entries = recentComposerHistory(scope).slice(0, MAX_RECENT_INPUTS - 1);
  recent.delete(key);
  recent.set(key, [entry, ...entries]);
  if (recent.size > MAX_RECENT_SCOPES) {
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) recent.delete(oldest);
  }
}

export function discardComposerHistory(sessionId: string): void {
  for (const key of recent.keys()) {
    if (JSON.parse(key)[0] === sessionId) recent.delete(key);
  }
}
