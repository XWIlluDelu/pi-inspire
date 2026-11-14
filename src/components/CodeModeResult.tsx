import { Fragment, type ReactElement, type ReactNode, useMemo } from "react";
import { stripTerminalSequences } from "../ansi";
import type { ChatMessage } from "../events";
import {
  type ToolPresentationBlock,
  toolResultImage,
} from "../tool-presentations/model";
import { CodeView } from "./CodeView";
import { useActivityReaderScroll } from "./transcript-activity-visibility";

function partText(part: unknown) {
  if (!part || typeof part !== "object") return undefined;
  const item = part as Record<string, unknown>;
  if (item.type === "text" && typeof item.text === "string") return item.text;
}

/** Only a standalone first-part runner banner is metadata, not user output. */
export function codeModeDuration(result?: ChatMessage): string | undefined {
  const { content } = result ?? {};
  const text = Array.isArray(content) ? partText(content[0]) : content;
  const seconds =
    typeof text === "string" &&
    /^Script (?:completed|failed)\nWall time (\d+(?:\.\d+)?) seconds\nOutput:\n$/.exec(
      text,
    )?.[1];
  return seconds ? `${seconds}s` : undefined;
}

/** Reading layout, not JSON source: show string newlines without changing keys
 * or numeric literals. Copy always uses the original result, not this text. */
function readableText(raw: string): string {
  try {
    JSON.parse(raw);
  } catch {
    return stripTerminalSequences(raw);
  }
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g)!;
  const lines: string[] = [];
  let line = "";
  let depth = 0;
  // Keep deeply nested data within a readable column; brackets retain its structure.
  const indent = () => "  ".repeat(Math.min(depth, 20));
  const newline = () => {
    lines.push(line);
    line = indent();
  };
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    if (token === "{" || token === "[") {
      line += token;
      depth++;
      if (next !== "}" && next !== "]") newline();
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[index - 1] !== "{" && tokens[index - 1] !== "[") newline();
      line += token;
    } else if (token === ",") {
      line += token;
      newline();
    } else if (token === ":") {
      line += ": ";
    } else if (token.startsWith('"') && next !== ":") {
      const value = stripTerminalSequences(JSON.parse(token) as string);
      line +=
        '"' +
        value
          .split("\n")
          .map((part) => JSON.stringify(part).slice(1, -1))
          .join("\n" + indent() + "  ") +
        '"';
    } else {
      line += token;
    }
  }
  lines.push(line);
  return lines.join("\n");
}

type ImageBlock = Extract<ToolPresentationBlock, { type: "image" }>;

export function CodeModeResult({
  result,
  renderImage,
}: {
  result: ChatMessage;
  renderImage: (block: ImageBlock | null) => ReactNode;
}) {
  const parts = useMemo(() => {
    const { content } = result;
    const banner = codeModeDuration(result);
    if (typeof content === "string")
      return content && !banner ? (
        <CodeView text={readableText(content)} />
      ) : null;
    if (!Array.isArray(content)) return null;
    const blocks = content.flatMap<ReactElement>((part, index) => {
      const text = partText(part);
      if (text && (index !== 0 || !banner))
        return [<CodeView key={index} text={readableText(text)} />];
      return part?.type === "image"
        ? [
            <Fragment key={index}>
              {renderImage(
                toolResultImage(result, index, "Script result image"),
              )}
            </Fragment>,
          ]
        : [];
    });
    return blocks.length ? blocks : null;
  }, [result, renderImage]);
  const scroll = useActivityReaderScroll<HTMLDivElement>(
    "codemode-result-scroll",
    result,
  );
  return (
    <div
      className="activity-reader codemode-result"
      {...scroll.props}
      tabIndex={0}
      role="group"
      aria-label="Result output"
    >
      {parts ?? <div className="tool-empty">No output</div>}
    </div>
  );
}
