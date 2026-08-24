import { MAX_COMPOSER_HISTORY_ENTRIES } from "../shared/contracts";

export interface ComposerHistoryScope {
  sessionId: string;
  viewId: string;
  incarnation: string | null;
}

interface HistoryPartition {
  entries: string[];
  pending: string[];
  hydrated: boolean;
  loading: Promise<string[]> | null;
  discarded: boolean;
}

const partitions = new Map<string, HistoryPartition>();
const MAX_CACHED_SCOPES = 12;

export function composerHistoryScopeKey(scope: ComposerHistoryScope): string {
  return JSON.stringify([scope.sessionId, scope.viewId, scope.incarnation]);
}

function touch(key: string, partition: HistoryPartition): void {
  partitions.delete(key);
  partitions.set(key, partition);
  while (partitions.size > MAX_CACHED_SCOPES) {
    const oldest = partitions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    partitions.delete(oldest);
  }
}

function partitionFor(scope: ComposerHistoryScope): HistoryPartition {
  const key = composerHistoryScopeKey(scope);
  const existing = partitions.get(key);
  if (existing) {
    touch(key, existing);
    return existing;
  }
  const created: HistoryPartition = {
    entries: [],
    pending: [],
    hydrated: false,
    loading: null,
    discarded: false,
  };
  touch(key, created);
  return created;
}

function prependHistory(entries: readonly string[], value: string): string[] {
  const text = value.trim();
  if (!text || entries[0] === text) return [...entries];
  return [text, ...entries].slice(0, MAX_COMPOSER_HISTORY_ENTRIES);
}

function mergePendingHistory(
  loaded: readonly string[],
  pending: readonly string[],
): string[] {
  let local: string[] = [];
  for (const text of pending) local = prependHistory(local, text);
  // A Host page may already include an initial prefix of prompts accepted while
  // the request was in flight. Its newest edge then matches a suffix of the
  // browser's local sequence; retain only the still-newer local prefix.
  for (let index = 0; index < local.length; index += 1) {
    const suffix = local.slice(index);
    if (
      suffix.length <= loaded.length &&
      suffix.every((entry, offset) => loaded[offset] === entry)
    )
      return [...local.slice(0, index), ...loaded].slice(
        0,
        MAX_COMPOSER_HISTORY_ENTRIES,
      );
  }
  let entries = loaded.slice(0, MAX_COMPOSER_HISTORY_ENTRIES);
  for (const text of pending) entries = prependHistory(entries, text);
  return entries;
}

export function composerHistory(scope: ComposerHistoryScope): string[] {
  return [...partitionFor(scope).entries];
}

export function rememberComposerHistory(
  scope: ComposerHistoryScope,
  value: string,
): string[] {
  const partition = partitionFor(scope);
  const text = value.trim();
  if (!text || partition.entries[0] === text) return [...partition.entries];
  partition.entries = prependHistory(partition.entries, text);
  if (!partition.hydrated) partition.pending.push(text);
  return [...partition.entries];
}

export async function hydrateComposerHistory(
  scope: ComposerHistoryScope,
  load: () => Promise<string[] | null>,
): Promise<string[]> {
  const key = composerHistoryScopeKey(scope);
  const partition = partitionFor(scope);
  if (partition.hydrated) return [...partition.entries];
  if (partition.loading) return partition.loading;

  let loading!: Promise<string[]>;
  loading = load()
    .then((loaded) => {
      if (partition.discarded) return [];
      if (loaded) {
        partition.entries = mergePendingHistory(loaded, partition.pending);
        partition.pending = [];
        partition.hydrated = true;
      }
      touch(key, partition);
      return [...partition.entries];
    })
    .finally(() => {
      if (partition.loading === loading) partition.loading = null;
    });
  partition.loading = loading;
  return loading;
}

export function discardComposerHistory(sessionId: string): void {
  for (const [key, partition] of partitions) {
    if (JSON.parse(key)[0] !== sessionId) continue;
    partitions.delete(key);
    partition.discarded = true;
    partition.pending = [];
  }
}

const CARET_LAYOUT_PROPERTIES = [
  "box-sizing",
  "width",
  "height",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "overflow-x",
  "overflow-y",
  "scrollbar-gutter",
  "scrollbar-width",
  "direction",
  "writing-mode",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "tab-size",
  "text-align",
  "text-indent",
  "text-transform",
  "text-rendering",
  "white-space",
  "word-break",
  "overflow-wrap",
] as const;

function logicalEdgeFallback(
  value: string,
  caret: number,
  edge: "first" | "last",
): boolean {
  return edge === "first"
    ? value.lastIndexOf("\n", Math.max(0, caret - 1)) < 0
    : value.indexOf("\n", caret) < 0;
}

/** Measure the browser's wrapped visual line without changing textarea selection. */
export function isTextareaCaretOnVisualEdge(
  textarea: HTMLTextAreaElement,
  edge: "first" | "last",
): boolean {
  const value = textarea.value;
  const caret = textarea.selectionStart;
  const fallback = logicalEdgeFallback(value, caret, edge);
  if (!value || !document.body) return true;

  const bounds = textarea.getBoundingClientRect();
  if (bounds.width <= 0) return fallback;
  const mirror = document.createElement("div");
  try {
    const computed = getComputedStyle(textarea);
    mirror.setAttribute("aria-hidden", "true");
    mirror.style.position = "fixed";
    mirror.style.left = "-100000px";
    mirror.style.top = "0";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    for (const property of CARET_LAYOUT_PROPERTIES) {
      mirror.style.setProperty(property, computed.getPropertyValue(property));
    }
    mirror.textContent = value;
    document.body.append(mirror);
    const text = mirror.firstChild;
    if (!text) return fallback;
    const topAt = (offset: number): number | null => {
      const range = document.createRange();
      range.setStart(text, offset);
      range.collapse(true);
      return range.getClientRects()[0]?.top ?? null;
    };
    const currentTop = topAt(caret);
    const edgeTop = topAt(edge === "first" ? 0 : value.length);
    if (currentTop === null || edgeTop === null) return fallback;
    return Math.abs(currentTop - edgeTop) < 0.5;
  } catch {
    return fallback;
  } finally {
    mirror.remove();
  }
}
