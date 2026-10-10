import { expect, it } from "vitest";
import { sessionSearchMatchRanges } from "../../src/session-search-presentation";

it.each([
  ["Alpha session", "ALPHA session", ["Alpha", "session"]],
  ["a x ab", "ab", ["a", "b"]],
  ["First   session plan", '"first session"', ["First   session"]],
  ["First unrelated session", '"first session"', []],
  ["Version 2", "2v", ["V", "2"]],
  ["İmage", "ig", ["İ", "g"]],
  ["Quoted session", '"session', []],
  ["Alpha session", "re:(a+)+$", []],
  ["Alpha session", "bodyOnly", []],
  ["Alpha session", "  ", []],
])(
  "emphasizes visible %s matches for %s without filtering rows",
  (text, query, expected) => {
    expect(
      sessionSearchMatchRanges(text, query).map((range) =>
        text.slice(range.start, range.end),
      ),
    ).toEqual(expected);
  },
);
