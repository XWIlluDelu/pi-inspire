import { memo, useMemo } from "react";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { stripTerminalSequences } from "../ansi";
import { CopyAction } from "./CopyAction";

const parser = unified().use(remarkParse);
const fullOutputPrefix = "Full output: ";

/** Decode the Host's shell-record fences, not Markdown written inside stdout. */
export const HistoryShellPreview = memo(function HistoryShellPreview({
  text,
  complete,
}: {
  text: string;
  complete: boolean;
}) {
  const content = useMemo(() => {
    const nodes = parser.parse(text).children;
    const parts = nodes.map((node) => ({
      code: node.type === "code",
      text:
        node.type === "code"
          ? node.value
          : text.slice(
              node.position!.start.offset!,
              node.position!.end.offset!,
            ),
    }));
    const last = parts.at(-1)?.text;
    const fullOutputPath =
      complete &&
      nodes.at(-1)?.type === "paragraph" &&
      last?.startsWith(fullOutputPrefix)
        ? last.slice(fullOutputPrefix.length)
        : null;
    const visible = fullOutputPath ? parts.slice(0, -1) : parts;
    const code = visible.filter((part) => part.code);
    const metadata = visible
      .filter((part) => !part.code)
      .map((part) => part.text);
    return {
      copy: parts
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n\n"),
      command: code[0]?.text ?? "",
      output: code
        .slice(1)
        .map((part) => part.text)
        .join("\n\n"),
      facts: metadata.filter((line) => line !== "Output truncated"),
      truncated: metadata.includes("Output truncated"),
      fullOutputPath,
    };
  }, [text, complete]);

  return (
    <section className="history-shell" aria-label="Shell record preview">
      <header className="history-shell__header">
        <div className="history-shell__facts">
          <span className="history-shell__kind">Shell</span>
          {content.facts.map((line, index) => {
            const exit = /^Exit (-?\d+)$/.exec(line);
            const outcome = exit
              ? Number(exit[1]) === 0
                ? "success"
                : "error"
              : line === "Cancelled"
                ? "warning"
                : undefined;
            return (
              <span
                key={index}
                className={outcome ? "history-shell__status" : undefined}
                data-outcome={outcome}
              >
                {line}
              </span>
            );
          })}
        </div>
        <CopyAction
          text={content.copy}
          label="loaded shell content"
          className="history-shell__copy-button"
        />
      </header>
      <pre className="history-shell__command">
        {stripTerminalSequences(content.command)}
      </pre>
      {content.output ? (
        <pre className="history-shell__output">
          {stripTerminalSequences(content.output)}
        </pre>
      ) : null}
      {content.truncated || content.fullOutputPath ? (
        <footer className="history-shell__footer">
          {content.truncated ? (
            <span>Pi truncated the recorded output</span>
          ) : null}
          {content.fullOutputPath ? (
            <button
              type="button"
              className="tool-notice__action"
              data-file-path={content.fullOutputPath}
              title={`Preview ${content.fullOutputPath}`}
              aria-label="View full shell output"
            >
              View full output
            </button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
});
