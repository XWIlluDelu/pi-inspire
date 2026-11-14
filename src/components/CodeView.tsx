import { type ComponentPropsWithRef, type CSSProperties, useMemo } from "react";
import type { GitDiffLine } from "../../shared/contracts";
import { highlightSource } from "../syntax-highlighting";

export function CodeView({
  text,
  language,
  className = "",
  children,
  ...props
}: ComponentPropsWithRef<"pre"> & { text?: string; language?: string }) {
  const html = useMemo(
    () =>
      language !== undefined && text !== undefined
        ? highlightSource(text, language)
        : null,
    [text, language],
  );
  return (
    <pre className={`code-view ${className}`} {...props}>
      {html === null ? (
        (text ?? children)
      ) : (
        <code
          className={language ? `hljs language-${language}` : "hljs"}
          // Highlighting escapes source and emits only balanced token spans.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </pre>
  );
}

/** Rows retain literal text unless an existing syntax renderer supplies HTML. */
interface CodeRow {
  text: string;
  html?: string;
  kind?: GitDiffLine["kind"] | "match";
  oldLine?: number | null;
  newLine?: number | null;
  changeIndex?: number | null;
  startsChange?: boolean;
}

export function CodeRows({
  rows,
  gutter,
  activeChange = null,
}: {
  rows: readonly CodeRow[];
  gutter?: "numbered" | "diff";
  activeChange?: number | null;
}) {
  const digits = useMemo(
    () =>
      gutter &&
      rows.reduce(
        (max, row) =>
          Math.max(
            max,
            String(row.oldLine ?? "").length,
            String(row.newLine ?? "").length,
          ),
        3,
      ),
    [rows, gutter],
  );
  return (
    <span
      className="code-lines"
      data-gutter={gutter}
      style={{ "--code-line-digits": digits } as CSSProperties}
    >
      {rows.map((row, index) => (
        <span
          className="code-row"
          key={index}
          data-kind={row.kind}
          data-active={
            (activeChange !== null && row.changeIndex === activeChange) ||
            undefined
          }
          data-change-index={row.startsChange ? row.changeIndex : undefined}
        >
          {gutter && (
            <span className="code-row__gutter" aria-hidden>
              {gutter === "diff" && (
                <span className="code-row__number">{row.oldLine}</span>
              )}
              <span className="code-row__number">{row.newLine}</span>
              {gutter === "diff" && (
                <span className="code-row__mark">
                  {row.kind === "add" ? "+" : row.kind === "delete" ? "−" : ""}
                </span>
              )}
            </span>
          )}
          {row.html === undefined ? (
            <code>{row.text}</code>
          ) : (
            <code dangerouslySetInnerHTML={{ __html: row.html }} />
          )}
          {!gutter && "\n"}
        </span>
      ))}
    </span>
  );
}
