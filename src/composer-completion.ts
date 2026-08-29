import { fuzzyFilter } from "@earendil-works/pi-tui";
import { INSPIRE_COMMANDS } from "../shared/commands";
import type { ProjectFileResult } from "./api";

export interface PiCommand {
  name: string;
  description?: string;
  /** Pi currently reports extension/prompt/skill. Keep unknown future sources
   * attributable instead of collapsing or rejecting them. */
  source?: string;
}

export type CaretCompletion =
  | { kind: "file"; start: number; end: number; query: string }
  | { kind: "command"; start: 0; end: number; query: string };

/** Parse only the token that owns the caret. File references begin at an `@`
 * preceded by whitespace (or the draft boundary) on the same line. Their
 * query may contain spaces; the caret is its authoritative query edge, while
 * a contiguous suffix under that caret remains part of the replaceable token.
 * Slash completion is stricter: Pi only recognizes the leading command token. */
export function parseCaretCompletion(
  value: string,
  caret: number,
): CaretCompletion | null {
  const point = Math.max(0, Math.min(value.length, caret));
  if (point > 0 && value.startsWith("/")) {
    const tokenEndMatch = /\s/.exec(value.slice(1));
    const tokenEnd = tokenEndMatch ? tokenEndMatch.index + 1 : value.length;
    if (point >= 1 && point <= tokenEnd) {
      return {
        kind: "command",
        start: 0,
        end: tokenEnd,
        query: value.slice(1, point),
      };
    }
  }

  const lineStart = point === 0 ? 0 : value.lastIndexOf("\n", point - 1) + 1;
  let trigger = -1;
  for (let index = lineStart; index < point; index += 1) {
    if (value[index] !== "@") continue;
    if (index === 0 || /\s/.test(value[index - 1]!)) trigger = index;
  }
  if (trigger < 0) return null;
  const query = value.slice(trigger + 1, point);
  if (query.length > 200 || query.includes("\n")) return null;
  let end = point;
  while (end < value.length && !/\s/.test(value[end]!)) end += 1;
  return { kind: "file", start: trigger, end, query };
}

export function replaceCompletionToken(
  value: string,
  token: Pick<CaretCompletion, "start" | "end">,
  replacement: string,
): { value: string; caret: number } {
  const next = `${value.slice(0, token.start)}${replacement}${value.slice(token.end)}`;
  return { value: next, caret: token.start + replacement.length };
}

function fuzzyScore(haystackValue: string, needleValue: string): number | null {
  const haystack = haystackValue.toLocaleLowerCase();
  const needle = needleValue.trim().toLocaleLowerCase();
  if (!needle) return 0;
  const direct = haystack.indexOf(needle);
  if (direct >= 0)
    return direct + Math.max(0, haystack.length - needle.length) / 100;
  let cursor = 0;
  let score = 20;
  let previous = -2;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found < 0) return null;
    score += found - cursor;
    if (found === previous + 1) score -= 0.5;
    if (found === 0 || /[\s/_.:-]/.test(haystack[found - 1]!)) score -= 1;
    previous = found;
    cursor = found + 1;
  }
  return score + haystack.length / 100;
}

export function rankProjectFiles(
  files: readonly ProjectFileResult[],
  query: string,
): ProjectFileResult[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  return files
    .flatMap((file) => {
      let score = 0;
      for (const word of words) {
        const pathScore = fuzzyScore(file.path, word);
        const nameScore = fuzzyScore(file.name, word);
        const wordScore =
          nameScore === null
            ? pathScore
            : pathScore === null
              ? nameScore - 2
              : Math.min(pathScore, nameScore - 2);
        if (wordScore === null) return [];
        score += wordScore;
      }
      return [{ file, score }];
    })
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.file.path.localeCompare(right.file.path),
    )
    .map(({ file }) => file);
}

export function resolveCommandInventory(
  commands: readonly PiCommand[],
): PiCommand[] {
  const byName = new Map<string, PiCommand>();
  // Pi dispatches the first matching extension command before prompt/skill
  // resources, so the first wire occurrence owns every runtime collision.
  for (const command of commands) {
    if (!byName.has(command.name)) byName.set(command.name, command);
  }
  // The host intercepts `/compact` before Pi dispatch, so its descriptor is
  // authoritative even if an extension or prompt registers the same name.
  for (const command of INSPIRE_COMMANDS) byName.set(command.name, command);
  return [...byName.values()];
}

export function rankCommands(
  commands: readonly PiCommand[],
  query: string,
): PiCommand[] {
  return fuzzyFilter([...commands], query, (command) => command.name);
}
