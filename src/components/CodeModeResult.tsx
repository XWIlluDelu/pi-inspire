import { Fragment, useMemo } from "react";
import { stripTerminalSequences } from "../ansi";
import type { ChatMessage } from "../events";
import {
  type ToolPresentationBlock,
  toolResultImage,
} from "../tool-presentations/model";

/** Only a standalone first-part runner banner is metadata, not user output. */
export function codeModeDuration(result?: ChatMessage): string | undefined {
  const first = Array.isArray(result?.content)
    ? result.content[0]
    : { type: "text", text: result?.content };
  if (!first || typeof first !== "object") return undefined;
  const part = first as Record<string, unknown>;
  const banner =
    part.type === "text" && typeof part.text === "string"
      ? /^Script (?:completed|failed)\nWall time (\d+(?:\.\d+)?) seconds\nOutput:\n$/.exec(
          part.text,
        )
      : null;
  return banner ? `${banner[1]}s` : undefined;
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
type ResultPart =
  | { kind: "text"; index: number; text: string }
  | { kind: "image"; index: number; image: ImageBlock | null };

function resultParts(result: ChatMessage): ResultPart[] {
  const banner = codeModeDuration(result);
  const content =
    typeof result.content === "string"
      ? [{ type: "text", text: result.content }]
      : Array.isArray(result.content)
        ? result.content
        : [];
  return content.flatMap((part, index): ResultPart[] => {
    if (!part || typeof part !== "object") return [];
    const item = part as Record<string, unknown>;
    if (
      item.type === "text" &&
      typeof item.text === "string" &&
      item.text.length
    )
      return index === 0 && banner
        ? []
        : [{ kind: "text", index, text: readableText(item.text) }];
    if (item.type === "image")
      return [
        {
          kind: "image",
          index,
          image: toolResultImage(result, index, "Script result image"),
        },
      ];
    return [];
  });
}

export function CodeModeResult({
  result,
  renderImage,
}: {
  result: ChatMessage;
  renderImage: (block: ImageBlock) => React.ReactNode;
}) {
  const parts = useMemo(() => resultParts(result), [result]);
  return (
    <div
      className="codemode-result"
      tabIndex={0}
      role="group"
      aria-label="Result output"
    >
      {parts.map((part) => (
        <Fragment key={part.index}>
          {part.kind === "text" ? (
            <pre className="codemode-result__text">{part.text}</pre>
          ) : part.image ? (
            renderImage(part.image)
          ) : (
            <div className="tool-notice tool-notice--warning">
              Image unavailable (unsupported or invalid image data)
            </div>
          )}
        </Fragment>
      ))}
      {!parts.length ? <div className="tool-empty">No output</div> : null}
    </div>
  );
}
