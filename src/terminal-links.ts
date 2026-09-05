import type { IBufferLine, ILink } from "@xterm/xterm";

const FILE_REFERENCE_PATTERN =
  /(?:^|[\s("'`])((?:(?:\.{1,2}[\\/])|[\\/]|[A-Za-z]:[\\/])?[\p{L}\p{N}\p{M}_@+.,~\\/-]+\.[A-Za-z0-9]{1,12}(?::\d{1,9})?(?::\d{1,9})?)/gu;

/** Regex indices are UTF-16 offsets; xterm link ranges are one-based cells. */
export function terminalFileLinks(
  line: IBufferLine,
  lineNumber: number,
  activate: (event: MouseEvent, text: string) => void,
): ILink[] {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    text += chars;
    for (let index = 0; index < chars.length; index += 1) {
      starts.push(column + 1);
      ends.push(column + cell.getWidth());
    }
  }
  const links: ILink[] = [];
  for (const match of text.matchAll(FILE_REFERENCE_PATTERN)) {
    const reference = match[1]!;
    if (
      !reference.includes("/") &&
      !reference.includes("\\") &&
      /\.(?:com|net|org|io)(?::\d+)?(?::\d+)?$/iu.test(reference)
    )
      continue;
    const offset = match.index + match[0].lastIndexOf(reference);
    links.push({
      range: {
        start: { x: starts[offset]!, y: lineNumber },
        end: { x: ends[offset + reference.length - 1]!, y: lineNumber },
      },
      text: reference,
      activate,
    });
  }
  return links;
}
