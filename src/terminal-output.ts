import type { IBuffer, IMarker } from "@xterm/xterm";

export interface TerminalCommandOutput {
  start: IMarker;
  startColumn: number;
  end: IMarker;
  endColumn: number;
}

/** Copy rendered cells, joining soft wraps without joining real line breaks. */
function readTerminalText(
  buffer: Pick<IBuffer, "getLine">,
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn?: number,
): string | null {
  let output = "";
  for (let line = startLine; line <= endLine; line += 1) {
    const row = buffer.getLine(line);
    if (!row) return null;
    if (line > startLine && !row.isWrapped) output += "\n";
    const wraps = buffer.getLine(line + 1)?.isWrapped;
    let lastColumn = line === endLine ? (endColumn ?? row.length) : row.length;
    if (wraps) {
      // A wide glyph may leave an unprinted cell at the previous margin.
      // Omit that padding, but preserve actual spaces at a soft wrap.
      while (lastColumn > 0) {
        const cell = row.getCell(lastColumn - 1);
        if (!cell || cell.getWidth() !== 1 || cell.getCode() !== 0) break;
        lastColumn -= 1;
      }
    }
    output += row.translateToString(
      !wraps,
      line === startLine ? startColumn : 0,
      lastColumn,
    );
  }
  return output.trimEnd();
}

/** The currently retained buffer, including scrollback but not ANSI escapes. */
export function terminalBufferText(buffer: IBuffer): string {
  return readTerminalText(buffer, 0, 0, buffer.length - 1) ?? "";
}

/** Copy only the command's output, excluding the subsequent prompt. */
export function terminalCommandOutput(
  buffer: Pick<IBuffer, "getLine">,
  range: TerminalCommandOutput,
): string | null {
  if (range.start.isDisposed || range.end.isDisposed) return null;
  return readTerminalText(
    buffer,
    range.start.line,
    range.startColumn,
    range.end.line,
    range.endColumn,
  );
}
