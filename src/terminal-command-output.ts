import type { IBuffer, IMarker } from "@xterm/xterm";

export interface TerminalCommandOutput {
  start: IMarker;
  startColumn: number;
  end: IMarker;
  endColumn: number;
}

/** Copy rendered cells between shell markers, not the subsequent prompt or
 * synthetic line breaks introduced by terminal wrapping. */
export function terminalCommandOutput(
  buffer: Pick<IBuffer, "getLine">,
  range: TerminalCommandOutput,
): string | null {
  if (range.start.isDisposed || range.end.isDisposed) return null;
  let output = "";
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    const row = buffer.getLine(line);
    if (!row) return null;
    if (line > range.start.line && !row.isWrapped) output += "\n";
    const wraps = buffer.getLine(line + 1)?.isWrapped;
    let endColumn = line === range.end.line ? range.endColumn : row.length;
    if (wraps) {
      // A wide glyph may leave an unprinted cell at the previous margin.
      // Omit that padding, but preserve actual spaces at a soft wrap.
      while (endColumn > 0) {
        const cell = row.getCell(endColumn - 1);
        if (!cell || cell.getWidth() !== 1 || cell.getCode() !== 0) break;
        endColumn -= 1;
      }
    }
    output += row.translateToString(
      !wraps,
      line === range.start.line ? range.startColumn : 0,
      endColumn,
    );
  }
  return output.trimEnd();
}
