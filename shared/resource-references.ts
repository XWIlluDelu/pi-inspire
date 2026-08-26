const FILE_ARGUMENT_KEYS = new Set([
  "archivePath",
  "file",
  "fileName",
  "filePath",
  "file_name",
  "file_path",
  "fullOutputPath",
  "output",
  "outputPath",
  "path",
  "referencedImagePaths",
]);

export function isToolResourceArgumentKey(key: string): boolean {
  return FILE_ARGUMENT_KEYS.has(key);
}

const TEXT_FILE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cfg",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "go",
  "gql",
  "graphql",
  "h",
  "hcl",
  "hpp",
  "htm",
  "html",
  "ini",
  "ipynb",
  "java",
  "js",
  "json",
  "jsonl",
  "jsx",
  "kt",
  "kts",
  "log",
  "lua",
  "markdown",
  "md",
  "mjs",
  "php",
  "properties",
  "proto",
  "py",
  "r",
  "rb",
  "rs",
  "sh",
  "sql",
  "svelte",
  "swift",
  "svg",
  "tex",
  "tf",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

const TEXT_FILE_BASENAMES = new Set([
  ".dockerignore",
  ".editorconfig",
  ".env",
  ".eslintignore",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  ".prettierignore",
  "changelog",
  "copying",
  "dockerfile",
  "gnumakefile",
  "license",
  "makefile",
  "readme",
]);

export function isTextFileName(value: string): boolean {
  const name = value.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  const extension = /\.([A-Za-z0-9]{1,12})$/u.exec(name)?.[1]?.toLowerCase();
  return Boolean(
    (extension && TEXT_FILE_EXTENSIONS.has(extension)) ||
      TEXT_FILE_BASENAMES.has(name) ||
      name.startsWith(".env."),
  );
}

const FILE_LIKE_EXTENSIONS = new Set([
  ...TEXT_FILE_EXTENSIONS,
  "avif",
  "bmp",
  "edf",
  "gif",
  "jpeg",
  "jpg",
  "m4a",
  "mat",
  "mov",
  "mp3",
  "mp4",
  "npy",
  "npz",
  "pdf",
  "png",
  "wav",
  "webm",
  "webp",
  "zip",
]);

const EXTERNAL_SCHEME = /^(?:https?|mailto|data|blob|javascript):/i;
const DOMAIN_LIKE =
  /^(?:www\.)?[\w.-]+\.(?:com|org|net|gov|edu|io|dev)(?:[/:?#]|$)/i;
const FILE_TAG = /<file\b[^>]*\bname\s*=\s*(["'])(.*?)\1/giu;
const MARKDOWN_TARGET = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/gu;
const OSC8_TARGET = /\u001b\]8;[^;]*;([^\u0007\u001b]+)(?:\u0007|\u001b\\)/gu;
const RESOURCE_LOCATION_FRAGMENT = /#L(\d+)(?:-L\d+)?$/i;
const RESOURCE_LOCATION_SUFFIX = /:(\d+)(?::\d+)?$/;

export function stripResourceLocation(reference: string): string {
  return reference
    .replace(RESOURCE_LOCATION_FRAGMENT, "")
    .replace(/[?#].*$/u, "")
    .replace(RESOURCE_LOCATION_SUFFIX, "");
}

/** First line named by the same suffix syntax stripped during resolution. */
export function resourceReferenceLine(reference: string): number | null {
  let value = reference.trim().replace(/^@/, "");
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  const fragment = RESOURCE_LOCATION_FRAGMENT.exec(value);
  const suffix = fragment
    ? null
    : RESOURCE_LOCATION_SUFFIX.exec(value.replace(/[?#].*$/u, ""));
  const line = Number(fragment?.[1] ?? suffix?.[1]);
  return Number.isSafeInteger(line) && line > 0 ? line : null;
}

const INLINE_CODE = /(?<!`)`([^`\n]+)`(?!`)/gu;
const EXPLICIT_PATH =
  /(?:^|[\s([])((?:file:\/\/)?\/(?:[^\s`<>()[\]{}"']+\/)*[^\s`<>()[\]{}"']+|(?:\.\.?\/|~\/)[^\s`<>()[\]{}"']+)/gmu;
const AT_PATH = /(?:^|\s)@((?:\.\.?\/)?[^\s`<>()[\]{}"']+)/gmu;

type ResourceReferenceSource =
  | "tool"
  | "link"
  | "attachment"
  | "mention"
  | "embedded";

export interface SessionResourceReference {
  key: string;
  reference?: string;
  label: string;
  source: ResourceReferenceSource;
  toolName?: string;
  mimeType?: string;
}

export const RESOURCE_LIST_INITIAL_SIZE = 8;
export const MAX_RESOURCE_LIST_PAGE_SIZE = 100;
export const MAX_RESOURCE_PROBE_REFERENCES = 16;

/** Browser-safe page from the complete reference projection of one branch view. */
export interface SessionResourceListResponse {
  sessionId: string;
  viewId: string;
  revision: number;
  offset: number;
  total: number;
  nextCursor: string | null;
  resources: SessionResourceReference[];
}

function trimReference(value: string): string {
  let result = value.trim();
  if (result.startsWith("<") && result.endsWith(">"))
    result = result.slice(1, -1).trim();
  if (result.startsWith("@")) result = result.slice(1);
  return result.replace(/[.,;!?]+$/u, "");
}

export function isLocalResourceReference(value: string): boolean {
  const reference = trimReference(value);
  if (
    !reference ||
    EXTERNAL_SCHEME.test(reference) ||
    DOMAIN_LIKE.test(reference) ||
    /[\\/]$/u.test(reference) ||
    reference.includes("*")
  )
    return false;
  if (
    /^(?:pi-embedded:\/\/|file:\/\/|vscode:\/\/file\/|\/|~\/|\.\.?\/)/i.test(
      reference,
    )
  )
    return true;
  const withoutLocation = reference
    .replace(/[?#].*$/u, "")
    .replace(/:\d+(?::\d+)?$/, "");
  const extension = /\.([A-Za-z0-9]{1,12})$/
    .exec(withoutLocation)?.[1]
    ?.toLowerCase();
  return Boolean(
    (extension && FILE_LIKE_EXTENSIONS.has(extension)) ||
      isTextFileName(withoutLocation),
  );
}

function referenceKey(value: string): string {
  return trimReference(value).replace(/^file:\/\//i, "");
}

function contentParts(
  message: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const content = message.content;
  if (Array.isArray(content))
    return content.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    );
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function valuesForArgument(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  return [];
}

function textReferences(
  text: string,
): Array<{ reference: string; source: ResourceReferenceSource }> {
  const found: Array<{
    reference: string;
    source: ResourceReferenceSource;
    position: number;
  }> = [];
  const add = (
    value: string,
    source: ResourceReferenceSource,
    position: number,
  ) => {
    const reference = trimReference(value);
    if (isLocalResourceReference(reference))
      found.push({ reference, source, position });
  };
  for (const match of text.matchAll(FILE_TAG))
    add(match[2] ?? "", "attachment", match.index ?? 0);
  for (const match of text.matchAll(MARKDOWN_TARGET))
    add(match[1] ?? match[2] ?? "", "link", match.index ?? 0);
  for (const match of text.matchAll(OSC8_TARGET))
    add(match[1] ?? "", "link", match.index ?? 0);
  for (const match of text.matchAll(INLINE_CODE))
    add(match[1] ?? "", "mention", match.index ?? 0);
  for (const match of text.matchAll(EXPLICIT_PATH))
    add(match[1] ?? "", "mention", match.index ?? 0);
  for (const match of text.matchAll(AT_PATH))
    add(match[1] ?? "", "mention", match.index ?? 0);
  return found
    .sort((left, right) => right.position - left.position)
    .map(({ reference, source }) => ({ reference, source }));
}

/**
 * Extract explicit local resources from Pi's stored message model. Structured
 * tool paths and image blocks are authoritative; text parsing is deliberately
 * limited to explicit Markdown/file tags, OSC 8 links, code spans, and visibly
 * path-shaped tokens.
 *
 * `limit` bounds a recent-first product projection and stops the walk once it
 * is full; authority callers pass no limit and keep the complete set.
 */
export function collectSessionResourceReferences(
  messages: readonly unknown[],
  limit = Number.POSITIVE_INFINITY,
): SessionResourceReference[] {
  const resources: SessionResourceReference[] = [];
  const seen = new Set<string>();
  const add = (resource: SessionResourceReference) => {
    if (resources.length >= limit || seen.has(resource.key)) return;
    seen.add(resource.key);
    resources.push(resource);
  };

  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0 && resources.length < limit;
    messageIndex -= 1
  ) {
    const raw = messages[messageIndex];
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const persistedIndex = Number.isSafeInteger(message.__inspireMessageIndex)
      ? Number(message.__inspireMessageIndex)
      : messageIndex;
    // Content Pi marked as non-display is not a visible reference source.
    if (message.display === false) continue;
    const parts = contentParts(message);
    for (
      let partIndex = parts.length - 1;
      partIndex >= 0 && resources.length < limit;
      partIndex -= 1
    ) {
      const part = parts[partIndex]!;
      if (
        part.type === "image" &&
        (typeof part.data === "string" ||
          Number.isSafeInteger(message.__inspireMessageIndex))
      ) {
        const mimeType =
          typeof part.mimeType === "string" ? part.mimeType : "image/unknown";
        const reference = `pi-embedded://${persistedIndex}/${partIndex}`;
        add({
          key: reference,
          reference,
          label: `Embedded image ${messageIndex + 1}`,
          source: "embedded",
          mimeType,
        });
        continue;
      }
      if (
        part.type === "toolCall" &&
        part.arguments &&
        typeof part.arguments === "object"
      ) {
        const toolName = typeof part.name === "string" ? part.name : undefined;
        for (const [key, value] of Object.entries(
          part.arguments as Record<string, unknown>,
        )) {
          if (!isToolResourceArgumentKey(key)) continue;
          for (const rawReference of valuesForArgument(value)) {
            const reference = trimReference(rawReference);
            if (!isLocalResourceReference(reference)) continue;
            add({
              key: `file:${referenceKey(reference)}`,
              reference,
              label: reference,
              source: "tool",
              toolName,
            });
          }
        }
      }
      // Thinking parts are excluded on purpose: thinking visibility is an
      // independent preference, so its paths must not surface as resources.
      const text = typeof part.text === "string" ? part.text : "";
      for (const candidate of textReferences(text)) {
        add({
          key: `file:${referenceKey(candidate.reference)}`,
          reference: candidate.reference,
          label: candidate.reference,
          source: candidate.source,
        });
      }
    }

    if (message.details && typeof message.details === "object") {
      for (const [key, value] of Object.entries(
        message.details as Record<string, unknown>,
      )) {
        if (!isToolResourceArgumentKey(key)) continue;
        for (const rawReference of valuesForArgument(value)) {
          const reference = trimReference(rawReference);
          if (!isLocalResourceReference(reference)) continue;
          add({
            key: `file:${referenceKey(reference)}`,
            reference,
            label: reference,
            source: "tool",
          });
        }
      }
    }
  }
  return resources;
}
