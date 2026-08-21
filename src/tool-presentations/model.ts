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

export type ToolImageMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "image/bmp";

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
      oldText: string;
      newText: string;
    }
  | {
      type: "image";
      label?: string;
      data: string;
      mimeType: ToolImageMimeType;
      alt: string;
    }
  | {
      type: "notice";
      text: string;
      tone?: "muted" | "warning" | "error";
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
