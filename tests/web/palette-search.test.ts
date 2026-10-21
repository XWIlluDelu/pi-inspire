import { expect, it } from "vitest";
import {
  paletteTextMatchRanges,
  rankPaletteItems,
} from "../../src/palette-search";

it.each([
  ["Settings", " /SET ", ["Set"]],
  ["Settings", "st", ["S", "t"]],
  ["Session information", "session cost", ["Session"]],
  ["Settings", "preferences", []],
  ["Settings", "", []],
  ["Project shell", "SHELL", ["shell"]],
  ["Project shell", "terminal shell", ["shell"]],
  ["Branch navigation", "/BRANCH", ["Branch"]],
])(
  "emphasizes visible text %s matching %s without inventing hidden matches",
  (title, query, expected) => {
    expect(
      paletteTextMatchRanges(title, query).map((range) =>
        title.slice(range.start, range.end),
      ),
    ).toEqual(expected);
  },
);

it("ranks exact aliases above category noise and still discovers descriptive tasks", () => {
  expect(
    rankPaletteItems(
      [
        { title: "Terminal settings" },
        { title: "Settings", aliases: ["settings"] },
      ],
      "settings",
    )[0]?.title,
  ).toBe("Settings");
  const tasks = [
    { title: "Close terminal" },
    {
      title: "Session information",
      aliases: ["session"],
      hint: "Tokens and cost for this session",
    },
    { title: "Cost", aliases: ["cost"] },
  ];
  expect(rankPaletteItems(tasks.slice(0, 2), "cost")[0]?.title).toBe(
    "Session information",
  );
  expect(rankPaletteItems(tasks, "cost")[0]?.title).toBe("Cost");
  expect(rankPaletteItems(tasks, "tokens cost")[0]?.title).toBe(
    "Session information",
  );
});
