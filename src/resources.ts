import {
  collectSessionResourceReferences,
  type SessionResourceReference,
} from "../shared/resource-references";

export interface ResourceRow extends SessionResourceReference {
  /** Basename used for display. */
  name: string;
  /** Lowercase extension without the dot; empty for embedded content. */
  extension: string;
}

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);

const CODE_EXTENSIONS = new Set([
  "c", "cc", "cpp", "css", "go", "h", "hpp", "js", "json", "jsonl", "jsx", "mjs", "py", "r", "rs",
  "sh", "tex", "toml", "ts", "tsx", "xml", "yaml", "yml",
]);

export type ResourceIcon = "image" | "code" | "text" | "file";

export function resourceIcon(row: Pick<ResourceRow, "extension" | "mimeType">): ResourceIcon {
  if (row.mimeType?.startsWith("image/") || IMAGE_EXTENSIONS.has(row.extension)) return "image";
  if (CODE_EXTENSIONS.has(row.extension)) return "code";
  if (row.extension === "md" || row.extension === "markdown" || row.extension === "txt" || row.extension === "log" || row.extension === "csv" || row.extension === "tsv") return "text";
  return "file";
}

/** Derive the deduplicated, recent-first resource list for the visible
 * session's messages. Extraction rules live in the shared pure module; this
 * only adds presentation metadata. */
export function collectResources(messages: readonly unknown[]): ResourceRow[] {
  return collectSessionResourceReferences(messages).map((reference) => {
    const displayReference = reference.label.replace(/[?#].*$/u, "").replace(/:\d+(?::\d+)?$/, "");
    const rawBasename = displayReference.split(/[\\/]/).pop() || displayReference;
    let basename = rawBasename;
    try {
      basename = decodeURIComponent(rawBasename);
    } catch {
      // Keep the literal reference when it contains malformed URL escapes.
    }
    const extension = /\.([A-Za-z0-9]{1,12})$/.exec(basename)?.[1]?.toLowerCase() ?? "";
    return {
      ...reference,
      name: reference.source === "embedded" ? reference.label : basename,
      extension,
    };
  });
}
