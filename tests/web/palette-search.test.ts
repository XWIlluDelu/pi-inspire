import { expect, it } from "vitest";
import { rankPaletteItems } from "../../src/palette-search";

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
