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

/** File references need valid Unicode text and cannot contain a native NUL. */
export function isResourceReferenceText(value: string): boolean {
  return !/\p{Surrogate}/u.test(value) && !value.includes("\0");
}

export function isToolResourceArgumentKey(key: string): boolean {
  return FILE_ARGUMENT_KEYS.has(key);
}

const TEXT_FILE_EXTENSIONS = new Set([
  "bash",
  "bat",
  "c",
  "cc",
  "cfg",
  "cmd",
  "conf",
  "cpp",
  "cs",
  "csproj",
  "css",
  "csv",
  "fish",
  "fsproj",
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
  "m",
  "markdown",
  "md",
  "mjs",
  "mm",
  "php",
  "plist",
  "properties",
  "props",
  "proto",
  "ps1",
  "psd1",
  "psm1",
  "py",
  "r",
  "rb",
  "resx",
  "rs",
  "sh",
  "sln",
  "slnx",
  "sql",
  "svelte",
  "swift",
  "svg",
  "targets",
  "tex",
  "tf",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "vbproj",
  "vcxproj",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

const TEXT_FILE_BASENAMES = new Set([
  ".bash_login",
  ".bash_logout",
  ".bash_profile",
  ".bashrc",
  ".profile",
  ".zlogin",
  ".zlogout",
  ".zprofile",
  ".zshenv",
  ".zshrc",
  ".gitattributes",
  ".gitconfig",
  ".gitmodules",
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

const EXTERNAL_SCHEME =
  /^(?:https?|ftp|sftp|ssh|wss?|tel|mailto|data|blob|javascript):/i;
const EXTERNAL_URL =
  /\b(?:https?|ftp|sftp|ssh|wss?|tel|mailto|data|blob|javascript):[^\s<>\u0060]+/giu;
const DOMAIN_LIKE =
  /^(?:www\.)?[\w.-]+\.(?:com|org|net|gov|edu|io|dev)(?:[/:?#]|$)/i;
const FILE_TAG = /<file\b[^>]*\bname\s*=\s*(["'])(.*?)\1/giu;
const MARKDOWN_TARGET = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/gu;
const OSC8_TARGET = /\u001b\]8;[^;]*;([^\u0007\u001b]+)(?:\u0007|\u001b\\)/gu;
const RESOURCE_LOCATION_FRAGMENT = /#L(\d+)(?:-L\d+)?$/i;
const RESOURCE_LOCATION_SUFFIX = /(?::(\d+)(?::\d+)?|\((\d+)(?:,\s*\d+)?\))$/u;
const RESOURCE_URL = /^(?:file:\/\/|vscode:\/\/file\/|pi-embedded:\/\/)/iu;

/** Native filesystem text enters the resource protocol only through this
 * adapter. Preserve path separators/drive identity, but protect every byte
 * that the link/diagnostic grammar would otherwise interpret. */
function literalPathReference(path: string): string {
  return encodeURIComponent(path)
    .replace(
      /[!'()*]/gu,
      (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
    )
    .replace(/%2F/gu, "/")
    .replace(/%5C/gu, "\\")
    .replace(/^([A-Za-z])%3A(?=[\\/])/u, "$1:");
}

/** Structured file fields are literal filesystem paths, never URL or
 * diagnostic syntax. A URL-looking filename must not gain URI authority. */
export function fileResourceReference(value: string): string {
  return literalPathReference(value);
}

/** Text may explicitly append a diagnostic location. Extract that syntax
 * before encoding the native path; never reinterpret a literal tool path. */
export function diagnosticResourceReference(value: string): string {
  if (RESOURCE_URL.test(value)) return value;
  const location =
    RESOURCE_LOCATION_FRAGMENT.exec(value) ??
    RESOURCE_LOCATION_SUFFIX.exec(value);
  return location
    ? literalPathReference(value.slice(0, location.index)) + location[0]
    : literalPathReference(value);
}

/** Human-readable path projection of a link-form reference, decoded once.
 * Literal workspace paths and original tool labels must not pass through it. */
export function resourceReferenceLabel(reference: string): string {
  const path = stripResourceLocation(reference);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

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
  const line = Number(fragment?.[1] ?? suffix?.[1] ?? suffix?.[2]);
  return Number.isSafeInteger(line) && line > 0 ? line : null;
}

const INLINE_CODE = /(?<!`)`([^`\n]+)`(?!`)/gu;
const QUOTED_PATH = /"([^"\r\n]+)"|'([^'\r\n]+)'/gu;
const EXPLICIT_PATH_START =
  /(?:^|[\s([])((?:(?:file:\/\/)?\/|\.\.?[\\/]|~[\\/]|[A-Za-z]:[\\/]|\\\\(?=[^\\/\s]+[\\/])))/gu;
const DIAGNOSTIC_LOCATION =
  /^[^:\u0000-\u001f<>"\u0060]*?(?::[1-9]\d*(?::[1-9]\d*)?|#L[1-9]\d*(?:-L[1-9]\d*)?)(?=$|[\s,;:.)\]])/u;
const MSVC_DIAGNOSTIC_LOCATION =
  /^[^:\u0000-\u001f<>"\u0060]*?\.[A-Za-z0-9]{1,12}\([1-9]\d*(?:,[ \t]*[1-9]\d*)?\)(?=$|[\s,;:.)\]])/u;
const AT_PATH = /(?:^|\s)@((?:\.\.?\/)?[^\s`<>()[\]{}"']+)/gmu;

type ResourceReferenceSource =
  | "tool"
  | "link"
  | "attachment"
  | "mention"
  | "embedded";

export interface SessionResourceReference {
  /** Opaque identity retains representation, escaping and URL authority. */
  key: string;
  /** Link-form reference: literal native paths are escaped before transport. */
  reference?: string;
  /** Original authored/native text, never URL-decoded for display. */
  label: string;
  source: ResourceReferenceSource;
  toolName?: string;
  mimeType?: string;
}

export const RESOURCE_LIST_INITIAL_SIZE = 8;
export const MAX_RESOURCE_LIST_PAGE_SIZE = 100;
export const MAX_RESOURCE_PROBE_REFERENCES = 16;
// Keep the existing 8,192 native UTF-16-unit allowance after URI escaping:
// one BMP unit can become three UTF-8 bytes, each represented by %HH.
export const MAX_RESOURCE_PATH_LENGTH = 8_192;
export const MAX_RESOURCE_REFERENCE_LENGTH = MAX_RESOURCE_PATH_LENGTH * 9;

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
    !isResourceReferenceText(reference) ||
    EXTERNAL_SCHEME.test(reference) ||
    DOMAIN_LIKE.test(reference) ||
    /[\\/]$/u.test(reference) ||
    reference.includes("*")
  )
    return false;
  if (
    /^(?:pi-embedded:\/\/|file:\/\/|vscode:\/\/file\/|\/|~[\\/]|\.\.?[\\/]|[A-Za-z]:[\\/]|\\\\(?=[^\\/\s]+[\\/]))/i.test(
      reference,
    )
  )
    return true;
  const location =
    RESOURCE_LOCATION_FRAGMENT.exec(reference) ??
    RESOURCE_LOCATION_SUFFIX.exec(reference);
  return (
    isFileLikeName(location ? reference.slice(0, location.index) : reference) ||
    isFileLikeName(stripResourceLocation(reference))
  );
}

function contentParts(message: Record<string, unknown>): Array<{
  part: Record<string, unknown>;
  index: number;
}> {
  const content = message.content;
  if (Array.isArray(content))
    return content.flatMap((item, index) =>
      item && typeof item === "object"
        ? [{ part: item as Record<string, unknown>, index }]
        : [],
    );
  if (typeof content === "string")
    return [{ part: { type: "text", text: content }, index: 0 }];
  return [];
}

function valuesForArgument(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  return [];
}

/** Bare output needs a clear filename boundary: a diagnostic location, a
 * whole path line, or one whitespace-free token. Never cite a guessed prefix
 * of a space-containing path. Structured/quoted surfaces are collected below. */
function bareTextReferences(
  text: string,
  add: (value: string, start: number, end: number) => void,
): void {
  for (const lineMatch of text.matchAll(/[^\r\n]+/gu)) {
    const line = lineMatch[0];
    const starts = [...line.matchAll(EXPLICIT_PATH_START)];
    for (let index = 0; index < starts.length; index += 1) {
      const match = starts[index]!;
      const prefix = match[1]!;
      const start = match.index + match[0].length - prefix.length;
      // A second visibly rooted path is a boundary, not another directory
      // component borrowed from prose joining two references.
      const next = starts[index + 1];
      const fragment = line.slice(start, next?.index ?? line.length);
      const tail = fragment.slice(prefix.length);
      const location =
        DIAGNOSTIC_LOCATION.exec(tail) ?? MSVC_DIAGNOSTIC_LOCATION.exec(tail);
      if (location) {
        const reference = prefix + location[0];
        add(
          reference,
          lineMatch.index + start,
          lineMatch.index + start + reference.length,
        );
        continue;
      }

      const whole = trimReference(fragment);
      const name = stripResourceLocation(whole).split(/[\\/]/u).at(-1) ?? "";
      if (
        !next &&
        line.slice(0, start).trim() === "" &&
        name &&
        (!/\s/u.test(name) || isFileLikeName(name))
      ) {
        add(
          whole,
          lineMatch.index + start,
          lineMatch.index + start + fragment.length,
        );
        continue;
      }

      const token = /^[^\s\u0060<>()[\]{}"']+/u.exec(fragment)?.[0];
      if (!token) continue;
      // "Jane Doe/project/file" cannot authorize the existing sibling "Jane".
      // Ambiguous prose needs quoting or a location suffix instead.
      if (/^[ \t]+.*[\\/]/u.test(fragment.slice(token.length))) continue;
      // Also refuse a path followed by a space-containing continuation with no
      // final separator; neither fragment is an unambiguous filename claim.
      if (
        !isFileLikeName(stripResourceLocation(trimReference(token))) &&
        /^[ \t]+\S/u.test(fragment.slice(token.length))
      )
        continue;
      add(
        token,
        lineMatch.index + start,
        lineMatch.index + start + token.length,
      );
    }
  }
}

function isFileLikeName(value: string): boolean {
  const extension = /\.([A-Za-z0-9]{1,12})$/u.exec(value)?.[1]?.toLowerCase();
  return Boolean(
    (extension && FILE_LIKE_EXTENSIONS.has(extension)) || isTextFileName(value),
  );
}

function textReferences(text: string): Array<{
  reference: string;
  label: string;
  source: ResourceReferenceSource;
}> {
  const found: Array<{
    reference: string | null;
    label: string;
    source: ResourceReferenceSource;
    position: number;
    end: number;
  }> = [];
  const add = (
    value: string,
    source: ResourceReferenceSource,
    position: number,
    end: number,
  ) => {
    if (isLocalResourceReference(value)) {
      const reference =
        source === "link"
          ? value
          : source === "attachment"
            ? fileResourceReference(value)
            : diagnosticResourceReference(value);
      found.push({ reference, label: value, source, position, end });
    } else if (EXTERNAL_SCHEME.test(value)) {
      found.push({ reference: null, label: value, source, position, end });
    }
  };
  for (const match of text.matchAll(EXTERNAL_URL))
    found.push({
      reference: null,
      label: match[0],
      source: "link",
      position: match.index,
      end: match.index + match[0].length,
    });
  for (const match of text.matchAll(FILE_TAG))
    add(
      match[2] ?? "",
      "attachment",
      match.index,
      match.index + match[0].length,
    );
  for (const match of text.matchAll(MARKDOWN_TARGET))
    add(
      match[1] ?? match[2] ?? "",
      "link",
      match.index,
      match.index + match[0].length,
    );
  for (const match of text.matchAll(OSC8_TARGET))
    add(match[1] ?? "", "link", match.index, match.index + match[0].length);
  for (const match of text.matchAll(INLINE_CODE))
    add(match[1] ?? "", "mention", match.index, match.index + match[0].length);
  for (const match of text.matchAll(QUOTED_PATH))
    add(
      match[1] ?? match[2] ?? "",
      "mention",
      match.index,
      match.index + match[0].length,
    );
  bareTextReferences(text, (value, start, end) =>
    add(trimReference(value), "mention", start, end),
  );
  for (const match of text.matchAll(AT_PATH))
    add(
      trimReference(match[1] ?? ""),
      "mention",
      match.index,
      match.index + match[0].length,
    );

  // One explicit surface owns its bytes. In particular a complete quoted/link
  // path suppresses every shorter token found within that same path.
  found.sort(
    (left, right) => left.position - right.position || right.end - left.end,
  );
  const references: Array<{
    reference: string;
    label: string;
    source: ResourceReferenceSource;
  }> = [];
  let consumedThrough = -1;
  for (const item of found) {
    if (item.position < consumedThrough) continue;
    consumedThrough = item.end;
    if (item.reference !== null)
      references.push({
        reference: item.reference,
        label: item.label,
        source: item.source,
      });
  }
  return references.reverse();
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
  const addToolArgumentReferences = (
    values: Record<string, unknown>,
    metadata: Pick<SessionResourceReference, "toolName"> = {},
  ) => {
    for (const [key, value] of Object.entries(values)) {
      if (!isToolResourceArgumentKey(key)) continue;
      for (const rawReference of valuesForArgument(value)) {
        if (!isLocalResourceReference(rawReference)) continue;
        const reference = fileResourceReference(rawReference);
        add({
          key: `file:${reference}`,
          reference,
          label: rawReference,
          source: "tool",
          ...metadata,
        });
      }
    }
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
      let partPosition = parts.length - 1;
      partPosition >= 0 && resources.length < limit;
      partPosition -= 1
    ) {
      const { part, index: partIndex } = parts[partPosition]!;
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
        addToolArgumentReferences(part.arguments as Record<string, unknown>, {
          toolName: typeof part.name === "string" ? part.name : undefined,
        });
      }
      // Thinking parts are excluded on purpose: thinking visibility is an
      // independent preference, so its paths must not surface as resources.
      const text = typeof part.text === "string" ? part.text : "";
      for (const candidate of textReferences(text)) {
        add({
          key: `file:${candidate.reference}`,
          reference: candidate.reference,
          label: candidate.label,
          source: candidate.source,
        });
      }
    }

    if (message.details && typeof message.details === "object")
      addToolArgumentReferences(message.details as Record<string, unknown>);
  }
  return resources;
}
