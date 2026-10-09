import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResourcePathLabel } from "../../src/components/ResourcePathLabel";
import {
  SearchMatchText,
  searchMatchRanges,
} from "../../src/components/SearchMatchText";

describe("file search match presentation", () => {
  it.each([
    [
      "src/Main.ts",
      "  SRC  main ",
      [
        { start: 0, end: 3 },
        { start: 4, end: 8 },
      ],
    ],
    ["banana.ts", "ana BAN", [{ start: 0, end: 6 }]],
    ["file[1].ts", "[1]", [{ start: 4, end: 7 }]],
    [
      "İmage.png",
      "I png",
      [
        { start: 0, end: 1 },
        { start: 6, end: 9 },
      ],
    ],
    ["foo.ts", "  ", []],
  ])("maps %s matching %s to original text ranges", (text, query, expected) => {
    expect(searchMatchRanges(text, query)).toEqual(expected);
  });

  it("projects a path-spanning match into directory and filename without changing labels", () => {
    const path = "src/main.ts";
    const matches = searchMatchRanges(path, "src/ma");
    const { container } = render(
      <button type="button" aria-label={path}>
        <SearchMatchText text="main.ts" ranges={matches} offset={4} />
        <ResourcePathLabel path="src" title={path} matches={matches} />
      </button>,
    );
    expect(
      Array.from(
        container.querySelectorAll(".file-search-match"),
        (node) => node.textContent,
      ),
    ).toEqual(["ma", "src"]);
    expect(container.querySelector("bdi")).toHaveTextContent("src");
    expect(container.querySelector(".resource-path")).toHaveAttribute(
      "title",
      path,
    );
    expect(container.querySelector(".visually-hidden")).toHaveTextContent(
      "src",
    );
    expect(container.querySelector("button")).toHaveAccessibleName(path);
  });
});
