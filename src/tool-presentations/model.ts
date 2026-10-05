import type { ChatMessage, ToolCallContent } from "../events";

export interface ToolPresentationInput {
  call: ToolCallContent;
  result?: ChatMessage;
}

type ToolSummarySeparator = "space" | "dot";

export type ToolSummaryPart =
  | {
      kind: "text";
      text: string;
      separator?: ToolSummarySeparator;
      subdued?: boolean;
    }
  | {
      kind: "resource";
      text: string;
      reference: string;
      separator?: ToolSummarySeparator;
    };

export interface ToolPresentationSummary {
  parts: ToolSummaryPart[];
}

export interface ToolProperty {
  label: string;
  value: string;
  resourceRef?: string;
}

export interface ToolListItem {
  label: string;
  resourceRef?: string;
  kind?: "file" | "directory";
  detail?: string;
}

export interface ToolSearchMatch {
  line: number;
  text: string;
  match: boolean;
}

export interface ToolSearchGroup {
  path: string;
  matches: ToolSearchMatch[];
}

/** Overlapping context windows can repeat a line, sometimes as both context
 * and a match. Keep its first position and strongest highlighting. */
export function mergeSearchContext(
  groups: ToolSearchGroup[],
): ToolSearchGroup[] {
  return groups.map((group) => {
    const unique = new Map<string, ToolSearchMatch>();
    for (const match of group.matches) {
      const key = `${match.line}\0${match.text}`;
      const previous = unique.get(key);
      if (previous) previous.match ||= match.match;
      else unique.set(key, { ...match });
    }
    return { ...group, matches: [...unique.values()] };
  });
}

const TOOL_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
] as const;

export type ToolImageMimeType = (typeof TOOL_IMAGE_MIME_TYPES)[number];

export function isToolImageMimeType(
  value: unknown,
): value is ToolImageMimeType {
  return TOOL_IMAGE_MIME_TYPES.some((mimeType) => mimeType === value);
}

type ToolImageSource =
  | { data: string; reference?: never }
  | { reference: string; data?: never };

/** Keep the original content index: filtering image parts would retarget
 * persisted references when text or other blocks precede the image. */
export function toolResultImage(
  result: ChatMessage,
  partIndex: number,
  alt: string,
): Extract<ToolPresentationBlock, { type: "image" }> | null {
  const part = Array.isArray(result.content) ? result.content[partIndex] : null;
  if (!part || typeof part !== "object") return null;
  const image = part as Record<string, unknown>;
  if (image.type !== "image" || !isToolImageMimeType(image.mimeType))
    return null;
  const metadata = { type: "image" as const, mimeType: image.mimeType, alt };
  if (Number.isSafeInteger(result.__inspireMessageIndex))
    return {
      ...metadata,
      reference: `pi-embedded://${result.__inspireMessageIndex}/${partIndex}`,
    };
  if (
    typeof image.data !== "string" ||
    image.data.length === 0 ||
    image.data.length > 32_000_000 ||
    !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(image.data)
  )
    return null;
  return { ...metadata, data: image.data };
}

export type ToolPresentationBlock =
  | {
      type: "properties";
      label?: string;
      items: ToolProperty[];
    }
  | {
      type: "code";
      label?: string;
      text: string;
      path?: string;
      startLine?: number;
      lineNumbers?: boolean;
      language?: string;
    }
  | {
      type: "diff";
      label?: string;
      text: string;
      path?: string;
    }
  | {
      type: "terminal";
      label?: string;
      text: string;
      error?: boolean;
    }
  | {
      type: "list";
      label?: string;
      path?: string;
      items: ToolListItem[];
      emptyText?: string;
    }
  | {
      type: "search";
      label?: string;
      groups: ToolSearchGroup[];
      emptyText?: string;
    }
  | {
      type: "replacement";
      label: string;
      path?: string;
      /** Missing only in a Host-marked argument preview; not an empty replacement. */
      oldText?: string;
      newText?: string;
    }
  | ({
      type: "image";
      label?: string;
      mimeType: ToolImageMimeType;
      alt: string;
    } & ToolImageSource)
  | {
      type: "notice";
      text: string;
      tone?: "muted" | "warning" | "error";
      action?: { label: string; reference: string };
    }
  | {
      type: "markdown";
      label?: string;
      text: string;
      error?: boolean;
    }
  | {
      type: "text";
      label?: string;
      text: string;
      error?: boolean;
    };

/** A presentation is cheap to resolve. Its potentially large body is produced
 * only after the surrounding transcript card has mounted its expanded body. */
export interface ToolPresentation {
  summary: ToolPresentationSummary;
  blocks: () => ToolPresentationBlock[] | null;
}

export interface ToolPresentationRule {
  id: string;
  present: (input: ToolPresentationInput) => ToolPresentation | null;
}

export interface ResolvedToolPresentation extends ToolPresentation {
  ruleId: string;
}

export type ToolPresentationMappings = Readonly<Record<string, string>>;

export function toolPresentationSummaryText(
  summary: ToolPresentationSummary,
): string {
  return summary.parts.reduce((text, part, index) => {
    const separator =
      index === 0 ? "" : part.separator === "space" ? " " : " · ";
    return `${text}${separator}${part.text}`;
  }, "");
}
