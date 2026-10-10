import {
  fuzzySearchMatchRanges,
  mergeSearchMatchRanges,
} from "./components/SearchMatchText";
import { fuzzyScore } from "./composer-completion";

const paletteSearchQuery = (query: string) =>
  query.trim().toLocaleLowerCase().replace(/^\//u, "");

/** Emphasize a visible field without changing cross-field ranking. */
export function paletteTextMatchRanges(text: string, query: string) {
  const needle = paletteSearchQuery(query);
  if (!needle) return [];
  const fold = (value: string) => value.toLocaleLowerCase();
  const whole = fuzzySearchMatchRanges(text, needle, fold);
  return whole.length
    ? whole
    : mergeSearchMatchRanges(
        needle
          .split(/\s+/u)
          .flatMap((word) => fuzzySearchMatchRanges(text, word, fold)),
      );
}

interface PaletteSearchItem {
  title: string;
  aliases?: readonly string[];
  hint?: string;
}

/** Exact destinations lead; literal task words beat loose name subsequences. */
export function rankPaletteItems<T extends PaletteSearchItem>(
  items: readonly T[],
  query: string,
): T[] {
  const needle = paletteSearchQuery(query);
  if (!needle) return [...items];
  const words = needle.split(/\s+/u);
  return items
    .flatMap((item, index) => {
      const names = [item.title, ...(item.aliases ?? [])].map((name) =>
        name.toLocaleLowerCase().replace(/^\//u, ""),
      );
      const description =
        `${names.join(" ")} ${item.hint ?? ""}`.toLocaleLowerCase();
      let tier = Infinity;
      let score = Infinity;
      const consider = (candidateTier: number, candidateScore: number) => {
        if (
          candidateTier < tier ||
          (candidateTier === tier && candidateScore < score)
        ) {
          tier = candidateTier;
          score = candidateScore;
        }
      };
      for (const name of names) {
        const match = fuzzyScore(name, needle);
        if (match !== null)
          consider(
            name === needle ? 0 : name.startsWith(needle) ? 1 : 3,
            match,
          );
      }
      const literal = words.map((word) => description.indexOf(word));
      if (literal.every((position) => position >= 0))
        consider(
          2,
          literal.reduce((sum, position) => sum + position, 0),
        );
      const matches = words.map((word) => fuzzyScore(description, word));
      if (matches.every((match) => match !== null))
        consider(
          4,
          matches.reduce<number>((sum, match) => sum + (match ?? 0), 0),
        );
      return Number.isFinite(tier) ? [{ item, index, tier, score }] : [];
    })
    .sort(
      (left, right) =>
        left.tier - right.tier ||
        left.score - right.score ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}
