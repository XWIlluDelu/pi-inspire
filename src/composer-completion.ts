import { fuzzyFilter } from "@earendil-works/pi-tui";
import {
  nativeCommand,
  PI_NATIVE_COMMANDS,
  type PiNativeCommandExecution,
} from "../shared/commands";
import type { ModelOption } from "../shared/contracts";
import type { ProjectFileResult } from "./api";
import { supportedThinkingLevels } from "./model-options";

export interface PiCommand {
  name: string;
  description?: string;
  /** Pi currently reports extension/prompt/skill. Keep unknown future sources
   * attributable instead of collapsing or rejecting them. */
  source?: string;
  argumentHint?: string;
  /** Browser adaptation, not a capability claimed by Pi's runtime inventory. */
  execution?: PiNativeCommandExecution;
}

const INSPIRE_COMMANDS: PiCommand[] = PI_NATIVE_COMMANDS.map((command) => ({
  name: command.name,
  description: command.description,
  source: "builtin",
  execution: command.execution,
  ...("argumentHint" in command ? { argumentHint: command.argumentHint } : {}),
}));

export type CaretCompletion =
  | { kind: "file"; start: number; end: number; query: string }
  | { kind: "command"; start: 0; end: number; query: string }
  | {
      kind: "argument";
      name: "model" | "thinking";
      start: number;
      end: number;
      query: string;
    };

function referenceClosingQuote(value: string, start: number): number {
  for (
    let index = start;
    index < value.length && value[index] !== "\n";
    index++
  ) {
    if (value[index] === "\\") index++;
    else if (value[index] === '"') return index;
  }
  return -1;
}

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
    const argument = /^\/(model|thinking)[ \t]+/u.exec(value);
    if (
      argument &&
      point >= argument[0].length &&
      !/\s/u.test(value.slice(argument[0].length, point))
    ) {
      const start = argument[0].length;
      let end = start;
      while (end < value.length && !/\s/u.test(value[end]!)) end += 1;
      if (point <= end)
        return {
          kind: "argument",
          name: argument[1] as "model" | "thinking",
          start,
          end,
          query: value.slice(start, point),
        };
    }
  }

  const lineStart = point === 0 ? 0 : value.lastIndexOf("\n", point - 1) + 1;
  let trigger = -1;
  for (let index = lineStart; index < point; index += 1) {
    if (value[index] !== "@") continue;
    if (index !== 0 && !/\s/.test(value[index - 1]!)) continue;
    if (value[index + 1] === '"') {
      const close = referenceClosingQuote(value, index + 2);
      if (close >= 0 && point > close) {
        trigger = -1;
        index = close;
        continue;
      }
      trigger = index;
      break;
    }
    trigger = index;
  }
  if (trigger < 0) return null;
  const quoted = value[trigger + 1] === '"';
  const queryStart = trigger + (quoted ? 2 : 1);
  const closingQuote = quoted ? referenceClosingQuote(value, queryStart) : -1;
  if (closingQuote >= 0 && point > closingQuote) return null;
  const query = value.slice(queryStart, point);
  if (query.length > 200 || query.includes("\n")) return null;
  let end = point;
  if (quoted && closingQuote >= 0) end = closingQuote + 1;
  else while (end < value.length && !/\s/.test(value[end]!)) end += 1;
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

/** Keep a selected reference in the sentence rather than moving it to a chip.
 * Quoted paths match Pi's @ completion; JSON escaping also keeps unusual names
 * from introducing another line/token. Prospective-workspace paths are absolute
 * so changing the start directory cannot reinterpret the inserted reference. */
export function replaceFileCompletion(
  value: string,
  token: Pick<CaretCompletion, "start" | "end">,
  file: ProjectFileResult,
): { value: string; caret: number } {
  const path = file.workspaceCwd
    ? `${file.workspaceCwd.replace(/[\\/]+$/, "")}/${file.path}`
    : file.path;
  // The closing quote is a durable completion boundary, including after a
  // draft reload. Moving the caret inside it still opens path editing.
  const reference = `@${JSON.stringify(path)}`;
  const delimiter = value[token.end];
  const next = replaceCompletionToken(
    value,
    token,
    `${reference}${delimiter && /\s/u.test(delimiter) ? "" : " "}`,
  );
  return delimiter && /[ \t]/u.test(delimiter)
    ? { ...next, caret: next.caret + 1 }
    : next;
}

interface CommandArgumentCandidate {
  value: string;
  hint?: string;
}

export function commandArgumentCandidates(
  token: Extract<CaretCompletion, { kind: "argument" }>,
  models: readonly ModelOption[],
  activeModel: ModelOption | null,
): CommandArgumentCandidate[] {
  if (token.name === "thinking") {
    if (activeModel?.reasoning === false) return [];
    return fuzzyFilter(
      supportedThinkingLevels(activeModel),
      token.query,
      (level) => level,
    ).map((value) => ({ value }));
  }
  return fuzzyFilter(
    [...models],
    token.query,
    (model) => `${model.provider}/${model.id} ${model.name ?? ""}`,
  ).map((model) => ({
    value: `${model.provider}/${model.id}`,
    hint: model.name,
  }));
}

export function commandUsageHint(
  value: string,
  includeNativeCommands = true,
): string | null {
  const match = /^\/([A-Za-z][A-Za-z0-9:_-]*)\s/u.exec(value);
  if (!match) return null;
  const command = nativeCommand(match[1]!);
  if (
    !command?.argumentHint ||
    (!includeNativeCommands && command.name !== "compact")
  )
    return null;
  const usage: Record<string, string> = {
    model: "Choose a candidate or enter an exact provider/model.",
    thinking: "Choose a level supported by the active model.",
    name: "Enter a session name; omit it to show the current name.",
    compact: "Optional instructions for the compaction summary.",
    export:
      "Omit the path for HTML. A .jsonl path exports only the current branch. Quote paths containing spaces.",
  };
  return `/${command.name} ${command.argumentHint} — ${usage[command.name] ?? command.description}${command.execution === "terminal" ? " (Terminal only)" : ""}`;
}

export function fuzzyScore(
  haystackValue: string,
  needleValue: string,
): number | null {
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
  includeNativeCommands = true,
): PiCommand[] {
  const byName = new Map<string, PiCommand>();
  // Pi dispatches the first matching extension command before prompt/skill
  // resources, so the first wire occurrence owns every runtime collision.
  for (const command of commands) {
    if (!byName.has(command.name)) byName.set(command.name, command);
  }
  // A first-message composer can run inherited runtime resources and the
  // Host-owned /compact prompt path, but browser-surface commands need
  // an already selected session. Keep that reduced surface truthful.
  if (!includeNativeCommands) {
    // Do not advertise a colliding resource as runnable when this surface
    // cannot execute its built-in owner yet.
    for (const command of INSPIRE_COMMANDS) {
      if (command.name !== "compact") byName.delete(command.name);
    }
    const compact = INSPIRE_COMMANDS.find(
      (command) => command.name === "compact",
    )!;
    byName.set(compact.name, compact);
    return [...byName.values()];
  }
  // The interactive client handles built-ins before AgentSession.prompt().
  // RPC's resource dispatcher is a lower layer, not the TUI's precedence rule.
  for (const command of INSPIRE_COMMANDS) {
    byName.set(command.name, command);
  }
  return [...byName.values()];
}

export function rankCommands(
  commands: readonly PiCommand[],
  query: string,
): PiCommand[] {
  return fuzzyFilter([...commands], query, (command) => command.name);
}
