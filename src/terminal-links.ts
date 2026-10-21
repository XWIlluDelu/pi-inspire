import type { IBufferLine, ILink } from "@xterm/xterm";
import {
  diagnosticResourceReference,
  fileResourceReference,
} from "../shared/resource-references";

// Consume a complete quoted span before trying a bare path. A filename can
// contain spaces or punctuation; its tail must never become a different link.
const FILE_REFERENCE_PATTERN =
  /(?:^|[\s("'\x60])(?:"([^"\r\n]+)"(?::(\d{1,9})(?::(\d{1,9}))?)?|'([^'\r\n]+)'(?::(\d{1,9})(?::(\d{1,9}))?)?|((?:[A-Za-z]:[\\/]|[\\/])(?:(?! +(?:[A-Za-z]:[\\/]|[\\/]))[-\p{L}\p{N}\p{M}_@+.,%~\\/\x20()\[\]])+\.[A-Za-z0-9]{1,12}(?::\d{1,9})?(?::\d{1,9})?(?=$|[\s)"'\x60,:])|(?:(?:file:\/\/|vscode:\/\/file\/)(?:\/?[A-Za-z]:)?|(?:\.{1,2}[\\/])|[\\/]|[A-Za-z]:[\\/])?[\p{L}\p{N}\p{M}_@+.,%~\\/-]+\.[A-Za-z0-9]{1,12}(?::\d{1,9})?(?::\d{1,9})?))/gu;
const FILE_SUFFIX = /\.[A-Za-z0-9]{1,12}(?::\d{1,9})?(?::\d{1,9})?$/u;

function isFileReference(reference: string): boolean {
  if (!FILE_SUFFIX.test(reference)) return false;
  if (
    /^[a-z][a-z\d+.-]*:/iu.test(reference) &&
    !/^(?:[a-z]:[\\/]|file:\/\/|vscode:\/\/file\/)/iu.test(reference)
  )
    return false;
  return !(
    !reference.includes("/") &&
    !reference.includes("\\") &&
    /\.(?:com|net|org|io)(?::\d+)?(?::\d+)?$/iu.test(reference)
  );
}

/** The Host resolves its own URI/home syntax; the browser only joins relative
 * names to the terminal cwd, never to the browser's platform or directory. */
export function terminalFileReference(
  reference: string,
  currentCwd: string,
): string {
  if (/^(?:file:\/\/|vscode:\/\/file\/)/iu.test(reference)) return reference;
  if (/^(?:[\\/]|[A-Za-z]:[\\/]|~[\\/])/iu.test(reference))
    return diagnosticResourceReference(reference);
  const separator = currentCwd.includes("\\") ? "\\" : "/";
  return (
    fileResourceReference(currentCwd.replace(/[\\/]+$/u, "")) +
    separator +
    diagnosticResourceReference(reference)
  );
}

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
    const body = match[1] ?? match[4] ?? match[7]!;
    const line = match[2] ?? match[5];
    const column = match[3] ?? match[6];
    const location = line ? ":" + line + (column ? ":" + column : "") : "";
    const reference = body + location;
    if (!isFileReference(reference)) continue;
    const offset = match.index + match[0].indexOf(body);
    // A location outside quotes spans the closing quote on screen, but the
    // opened reference itself contains only the path and its line/column.
    const end = offset + body.length + (location ? 1 + location.length : 0) - 1;
    links.push({
      range: {
        start: { x: starts[offset]!, y: lineNumber },
        end: { x: ends[end]!, y: lineNumber },
      },
      text: reference,
      activate,
    });
  }
  return links;
}
