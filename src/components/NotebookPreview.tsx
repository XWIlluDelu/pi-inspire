import { useMemo } from "react";
import { ProgressiveRichText as RichText } from "./ProgressiveRichText";

const MAX_NOTEBOOK_CELLS = 200;
const MAX_NOTEBOOK_OUTPUTS = 400;
const MAX_NOTEBOOK_TEXT = 512 * 1024;
const MAX_INLINE_IMAGE_BASE64 = 4 * 1024 * 1024;

interface NotebookCell {
  kind: "markdown" | "code" | "raw";
  source: string;
  executionCount: string | null;
  outputs: NotebookOutput[];
}

type NotebookOutput =
  | { kind: "text" | "markdown" | "error"; text: string }
  | { kind: "image"; mimeType: string; base64: string }
  | { kind: "unsupported" };

interface NotebookDocument {
  cells: NotebookCell[];
  language: string;
  clipped: boolean;
  totalCells: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function joinedText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value.join("");
  return null;
}

function cleanTerminalText(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function outputFromBundle(value: unknown): NotebookOutput {
  const bundle = record(value);
  if (!bundle) return { kind: "unsupported" };
  for (const mimeType of [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]) {
    const encoded = joinedText(bundle[mimeType]);
    if (!encoded) continue;
    const base64 = encoded.replace(/\s+/g, "");
    if (
      base64.length <= MAX_INLINE_IMAGE_BASE64 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(base64)
    )
      return { kind: "image", mimeType, base64 };
  }
  const markdown = joinedText(bundle["text/markdown"]);
  if (markdown !== null) return { kind: "markdown", text: markdown };
  const plain = joinedText(bundle["text/plain"]);
  if (plain !== null) return { kind: "text", text: plain };
  const json = bundle["application/json"];
  if (json !== undefined)
    return { kind: "text", text: JSON.stringify(json, null, 2)! };
  return { kind: "unsupported" };
}

function normalizeOutput(value: unknown): NotebookOutput {
  const output = record(value);
  if (!output || typeof output.output_type !== "string")
    return { kind: "unsupported" };
  if (output.output_type === "stream") {
    const text = joinedText(output.text);
    return text === null
      ? { kind: "unsupported" }
      : { kind: "text", text: cleanTerminalText(text) };
  }
  if (output.output_type === "error") {
    const traceback = joinedText(output.traceback);
    if (traceback !== null)
      return { kind: "error", text: cleanTerminalText(traceback) };
    const name = typeof output.ename === "string" ? output.ename : "Error";
    const message = typeof output.evalue === "string" ? output.evalue : "";
    return { kind: "error", text: `${name}${message ? `: ${message}` : ""}` };
  }
  if (
    output.output_type === "display_data" ||
    output.output_type === "execute_result"
  )
    return outputFromBundle(output.data);
  return { kind: "unsupported" };
}

function parseNotebook(text: string): NotebookDocument | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const notebook = record(value);
  if (!notebook || !Array.isArray(notebook.cells)) return null;
  const metadata = record(notebook.metadata);
  const languageInfo = record(metadata?.language_info);
  const kernelspec = record(metadata?.kernelspec);
  const language =
    (typeof languageInfo?.name === "string" && languageInfo.name) ||
    (typeof kernelspec?.language === "string" && kernelspec.language) ||
    "python";
  let remainingText = MAX_NOTEBOOK_TEXT;
  let remainingOutputs = MAX_NOTEBOOK_OUTPUTS;
  let clipped = notebook.cells.length > MAX_NOTEBOOK_CELLS;
  const takeText = (input: string): string => {
    if (input.length <= remainingText) {
      remainingText -= input.length;
      return input;
    }
    const visible = input.slice(0, Math.max(0, remainingText));
    remainingText = 0;
    clipped = true;
    return visible;
  };
  const cells: NotebookCell[] = [];
  for (const rawCell of notebook.cells.slice(0, MAX_NOTEBOOK_CELLS)) {
    const cell = record(rawCell);
    const cellType = cell?.cell_type;
    if (
      !cell ||
      (cellType !== "markdown" && cellType !== "code" && cellType !== "raw")
    )
      continue;
    const source = joinedText(cell.source);
    if (source === null) continue;
    const executionCount =
      typeof cell.execution_count === "number" ||
      typeof cell.execution_count === "string"
        ? String(cell.execution_count)
        : null;
    const rawOutputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    const visibleOutputs = rawOutputs.slice(0, remainingOutputs);
    if (visibleOutputs.length < rawOutputs.length) clipped = true;
    remainingOutputs -= visibleOutputs.length;
    const outputs = visibleOutputs
      .map(normalizeOutput)
      .map((output) =>
        output.kind === "text" ||
        output.kind === "markdown" ||
        output.kind === "error"
          ? { ...output, text: takeText(output.text) }
          : output,
      );
    cells.push({
      kind: cellType,
      source: takeText(source),
      executionCount,
      outputs,
    });
    if (remainingText === 0) break;
  }
  return {
    cells,
    language,
    clipped,
    totalCells: notebook.cells.length,
  };
}

function NotebookOutputView({
  output,
  executionCount,
}: {
  output: NotebookOutput;
  executionCount: string | null;
}) {
  if (output.kind === "unsupported")
    return (
      <div className="notebook-preview__unsupported">
        This output is available in Source.
      </div>
    );
  return (
    <div
      className={`notebook-preview__output ${output.kind === "error" ? "notebook-preview__output--error" : ""}`}
    >
      <div className="notebook-preview__prompt" aria-hidden>
        {executionCount ? `Out [${executionCount}]` : "Output"}
      </div>
      <div className="notebook-preview__output-body">
        {output.kind === "markdown" ? (
          <RichText text={output.text} variant="assistant" />
        ) : output.kind === "image" ? (
          <img
            src={`data:${output.mimeType};base64,${output.base64}`}
            alt="Notebook output"
            loading="lazy"
          />
        ) : (
          <pre>{output.text}</pre>
        )}
      </div>
    </div>
  );
}

export function NotebookPreview({ text }: { text: string }) {
  const notebook = useMemo(() => parseNotebook(text), [text]);
  if (!notebook)
    return (
      <div className="notebook-preview notebook-preview--state">
        <strong>Notebook preview unavailable</strong>
        <span>Open Source to inspect this file.</span>
      </div>
    );
  if (notebook.cells.length === 0)
    return (
      <div className="notebook-preview notebook-preview--state">
        <strong>Empty notebook</strong>
      </div>
    );
  return (
    <div
      className="notebook-preview"
      role="document"
      aria-label="Notebook preview"
      data-pane-scroll-active="true"
    >
      {notebook.cells.map((cell, index) => (
        <article
          className={`notebook-preview__cell notebook-preview__cell--${cell.kind}`}
          key={index}
        >
          <div className="notebook-preview__prompt" aria-hidden>
            {cell.kind === "code"
              ? cell.executionCount
                ? `In [${cell.executionCount}]`
                : "In [ ]"
              : cell.kind === "markdown"
                ? "Markdown"
                : "Raw"}
          </div>
          <div className="notebook-preview__cell-body">
            {cell.kind === "markdown" ? (
              <RichText text={cell.source} variant="assistant" />
            ) : (
              <pre>
                <code className={`language-${notebook.language}`}>
                  {cell.source}
                </code>
              </pre>
            )}
          </div>
          {cell.outputs.map((output, outputIndex) => (
            <NotebookOutputView
              key={outputIndex}
              output={output}
              executionCount={cell.executionCount}
            />
          ))}
        </article>
      ))}
      {notebook.clipped ? (
        <div className="notebook-preview__more" role="status">
          Showing a bounded preview of {notebook.totalCells} cells. Open Source
          for the complete file.
        </div>
      ) : null}
    </div>
  );
}
