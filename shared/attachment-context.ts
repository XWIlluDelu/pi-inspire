import { stripImageDimensionNotes } from "./image-dimension-notes.js";

export const ATTACHMENT_CONTEXT_HEADING =
  "Referenced files available to the agent (JSON paths):";

function isAbsoluteReference(path: string): boolean {
  return /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path);
}

/** Split only the exact trailing transport block. Paths are descriptions, not
 * access capabilities; Host callers retain their platform-specific validation. */
export function parseAttachmentContext(
  source: string,
  imageCount = 0,
  isAbsolute: (path: string) => boolean = isAbsoluteReference,
) {
  const prompt = stripImageDimensionNotes(source, imageCount);
  const heading = `${ATTACHMENT_CONTEXT_HEADING}\n`;
  const marker = `\n\n${heading}`;
  const trailingContext = prompt.lastIndexOf(marker);
  const contextStart =
    trailingContext >= 0
      ? trailingContext
      : prompt.startsWith(heading)
        ? 0
        : -1;
  if (contextStart < 0) return { text: prompt, references: [] };
  const referenceStart =
    trailingContext >= 0 ? trailingContext + marker.length : heading.length;
  const references: string[] = [];
  const lines = prompt.slice(referenceStart).split("\n");
  if (
    lines.length === 0 ||
    lines.some((line) => {
      if (!line.startsWith("- ")) return true;
      try {
        const path: unknown = JSON.parse(line.slice(2));
        if (typeof path !== "string" || !isAbsolute(path)) return true;
        references.push(path);
        return false;
      } catch {
        return true;
      }
    })
  )
    return { text: prompt, references: [] };
  return {
    text: contextStart === 0 ? "" : prompt.slice(0, contextStart),
    references,
  };
}

const UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const UPLOAD_DIRECTORY = new RegExp(`^\\d+-\\d+-${UUID}$`, "i");
const UPLOAD_PREFIX = new RegExp(`^${UUID}-(.+)$`, "i");

/** Label only: never infer ownership or a new path from the displayed name. */
export function fileReferenceName(path: string): string {
  const normalized = /^(?:[a-z]:[\\/]|\\\\)/i.test(path)
    ? path.replaceAll("\\", "/")
    : path;
  const parts = normalized.split("/");
  const name = parts.at(-1) || "file";
  // The default private upload store uses a process/time/UUID directory and a
  // UUID-prefixed safe filename. Keep genuine UUID-named project files intact.
  return UPLOAD_DIRECTORY.test(parts.at(-2) ?? "")
    ? (UPLOAD_PREFIX.exec(name)?.[1] ?? name)
    : name;
}
