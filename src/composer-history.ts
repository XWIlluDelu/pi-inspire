import {
  type ComposerHistoryEntry,
  MAX_COMPOSER_HISTORY_ENTRIES,
} from "../shared/contracts";

export interface ComposerHistoryScope {
  sessionId: string;
  viewId: string;
  incarnation: string | null;
  effectiveLeafId: string | null;
}

interface HistoryPartition {
  entries: ComposerHistoryEntry[];
  pending: ComposerHistoryEntry[];
  hydrated: boolean;
  loading: Promise<ComposerHistoryEntry[]> | null;
  discarded: boolean;
}

const partitions = new Map<string, HistoryPartition>();
const MAX_CACHED_SCOPES = 12;

export function composerHistoryScopeKey(scope: ComposerHistoryScope): string {
  return JSON.stringify([
    scope.sessionId,
    scope.viewId,
    scope.incarnation,
    scope.effectiveLeafId,
  ]);
}

function copyEntries(
  entries: readonly ComposerHistoryEntry[],
): ComposerHistoryEntry[] {
  return entries.map((entry) => ({
    text: entry.text,
    images: entry.images.map((image) => ({ ...image })),
    files: entry.files.map((file) => ({ ...file })),
  }));
}

function samePrompt(
  left: ComposerHistoryEntry | undefined,
  right: ComposerHistoryEntry,
): boolean {
  return Boolean(
    left &&
      left.text === right.text &&
      left.images.length === right.images.length &&
      left.images.every(
        (image, index) => image.reference === right.images[index]?.reference,
      ) &&
      left.files.length === right.files.length &&
      left.files.every(
        (file, index) => file.reference === right.files[index]?.reference,
      ),
  );
}

function normalizedEntry(
  value: string | ComposerHistoryEntry,
): ComposerHistoryEntry | null {
  const entry =
    typeof value === "string"
      ? { text: value.trim(), images: [], files: [] }
      : {
          text: value.text.trim(),
          images: value.images.map((image) => ({ ...image })),
          files: value.files.map((file) => ({ ...file })),
        };
  return entry.text || entry.images.length > 0 || entry.files.length > 0
    ? entry
    : null;
}

function discardPartition(partition: HistoryPartition): void {
  partition.discarded = true;
  partition.entries = [];
  partition.pending = [];
}

function touch(key: string, partition: HistoryPartition): void {
  partitions.delete(key);
  partitions.set(key, partition);
  while (partitions.size > MAX_CACHED_SCOPES) {
    const oldest = partitions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = partitions.get(oldest);
    partitions.delete(oldest);
    if (evicted) discardPartition(evicted);
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

function prependHistory(
  entries: readonly ComposerHistoryEntry[],
  value: ComposerHistoryEntry,
): ComposerHistoryEntry[] {
  if (samePrompt(entries[0], value)) return copyEntries(entries);
  return [value, ...copyEntries(entries)].slice(
    0,
    MAX_COMPOSER_HISTORY_ENTRIES,
  );
}

function mergePendingHistory(
  loaded: readonly ComposerHistoryEntry[],
  pending: readonly ComposerHistoryEntry[],
): ComposerHistoryEntry[] {
  let local: ComposerHistoryEntry[] = [];
  for (const entry of pending) local = prependHistory(local, entry);
  // A Host page may already include an initial prefix of prompts accepted while
  // the request was in flight. Its newest edge then matches a suffix of the
  // browser's local sequence; retain only the still-newer local prefix.
  for (let index = 0; index < local.length; index += 1) {
    const suffix = local.slice(index);
    if (
      suffix.length <= loaded.length &&
      suffix.every((entry, offset) => samePrompt(loaded[offset], entry))
    )
      return copyEntries([...local.slice(0, index), ...loaded]).slice(
        0,
        MAX_COMPOSER_HISTORY_ENTRIES,
      );
  }
  let entries = copyEntries(loaded).slice(0, MAX_COMPOSER_HISTORY_ENTRIES);
  for (const entry of pending) entries = prependHistory(entries, entry);
  return entries;
}

export function composerHistory(
  scope: ComposerHistoryScope,
): ComposerHistoryEntry[] {
  return copyEntries(partitionFor(scope).entries);
}

export function rememberComposerHistory(
  scope: ComposerHistoryScope,
  value: string | ComposerHistoryEntry,
): ComposerHistoryEntry[] {
  const partition = partitionFor(scope);
  const entry = normalizedEntry(value);
  if (!entry || samePrompt(partition.entries[0], entry))
    return copyEntries(partition.entries);
  partition.entries = prependHistory(partition.entries, entry);
  if (!partition.hydrated) partition.pending.push(entry);
  return copyEntries(partition.entries);
}

export async function hydrateComposerHistory(
  scope: ComposerHistoryScope,
  load: () => Promise<ComposerHistoryEntry[] | null>,
): Promise<ComposerHistoryEntry[]> {
  const key = composerHistoryScopeKey(scope);
  const partition = partitionFor(scope);
  if (partition.hydrated) return copyEntries(partition.entries);
  if (partition.loading) return partition.loading;

  let loading!: Promise<ComposerHistoryEntry[]>;
  loading = load()
    .then((loaded) => {
      if (partition.discarded) return [];
      if (loaded) {
        partition.entries = mergePendingHistory(loaded, partition.pending);
        partition.pending = [];
        partition.hydrated = true;
      }
      touch(key, partition);
      return copyEntries(partition.entries);
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
    discardPartition(partition);
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
    ? caret === 0 || value.lastIndexOf("\n", caret - 1) < 0
    : value.indexOf("\n", caret) < 0;
}

function mountTextareaMirror(
  textarea: HTMLTextAreaElement,
  left: number,
  top: number,
): {
  mirror: HTMLDivElement;
  text: Text;
  computed: CSSStyleDeclaration;
} {
  const computed = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.position = "fixed";
  mirror.style.left = `${left}px`;
  mirror.style.top = `${top}px`;
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  for (const property of CARET_LAYOUT_PROPERTIES) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }
  const text = document.createTextNode(textarea.value);
  mirror.append(text);
  document.body.append(mirror);
  return { mirror, text, computed };
}

function collapsedCaretRect(text: Node, offset: number): DOMRect | null {
  const range = document.createRange();
  range.setStart(text, offset);
  range.collapse(true);
  return range.getClientRects()[0] ?? null;
}

interface TextareaCaretLineBounds {
  top: number;
  bottom: number;
}

/** Locate the caret's visible line box without changing textarea selection. */
export function textareaCaretLineBounds(
  textarea: HTMLTextAreaElement,
  caret = textarea.selectionStart,
): TextareaCaretLineBounds | null {
  const value = textarea.value;
  const bounds = textarea.getBoundingClientRect();
  if (!value || bounds.width <= 0) return null;

  let mirror: HTMLDivElement | null = null;
  try {
    const mounted = mountTextareaMirror(textarea, bounds.left, bounds.top);
    mirror = mounted.mirror;
    mirror.scrollLeft = textarea.scrollLeft;
    mirror.scrollTop = textarea.scrollTop;
    const offset = Math.max(0, Math.min(value.length, caret));
    const rect = collapsedCaretRect(mounted.text, offset);
    if (!rect) return null;
    const fontSize =
      Number.parseFloat(mounted.computed.fontSize) || rect.height;
    const lineHeight = Math.max(
      rect.height,
      Number.parseFloat(mounted.computed.lineHeight) || fontSize,
    );
    const renderedHeight = rect.height || fontSize;
    const top = rect.top - Math.max(0, lineHeight - renderedHeight) / 2;
    return { top, bottom: top + lineHeight };
  } catch {
    return null;
  } finally {
    mirror?.remove();
  }
}

/** Measure the browser's wrapped visual line without changing textarea selection. */
export function isTextareaCaretOnVisualEdge(
  textarea: HTMLTextAreaElement,
  edge: "first" | "last",
): boolean {
  const value = textarea.value;
  const caret = textarea.selectionStart;
  const fallback = logicalEdgeFallback(value, caret, edge);
  if (!value) return true;

  const bounds = textarea.getBoundingClientRect();
  if (bounds.width <= 0) return fallback;
  let mirror: HTMLDivElement | null = null;
  try {
    const mounted = mountTextareaMirror(textarea, -100000, 0);
    mirror = mounted.mirror;
    const currentTop = collapsedCaretRect(mounted.text, caret)?.top ?? null;
    const edgeTop =
      collapsedCaretRect(mounted.text, edge === "first" ? 0 : value.length)
        ?.top ?? null;
    if (currentTop === null || edgeTop === null) return fallback;
    return Math.abs(currentTop - edgeTop) < 0.5;
  } catch {
    return fallback;
  } finally {
    mirror?.remove();
  }
}
