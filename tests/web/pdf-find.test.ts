// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  countOccurrences,
  markOccurrence,
  normalizeFindQuery,
  pageMatches,
} from "../../src/pdf-find";

describe("PDF find", () => {
  it("counts case-insensitive, whitespace-normalized occurrences per item", () => {
    const needle = normalizeFindQuery("  Sample   A ");
    expect(needle).toBe("sample a");
    expect(countOccurrences("Sample A, sample  a and SAMPLE A", needle)).toBe(
      3,
    );
    expect(pageMatches(2, ["Sample A", "", "x sample a"], needle)).toEqual([
      { page: 2, occurrence: 0 },
      { page: 2, occurrence: 1 },
    ]);
  });

  it("marks the span that holds an occurrence and clears earlier marks", () => {
    document.body.innerHTML =
      '<div id="l"><span>Sample A</span><span class="markedContent"><span>none</span><span>sample a twice sample a</span></span></div>';
    const layer = document.getElementById("l")!;
    const first = markOccurrence(layer, "sample a", 2, "hit")!;
    expect(first.textContent).toBe("sample a twice sample a");
    const again = markOccurrence(layer, "sample a", 0, "hit")!;
    expect(again.textContent).toBe("Sample A");
    expect(layer.querySelectorAll(".hit")).toHaveLength(1);
    expect(markOccurrence(layer, "sample a", 9, "hit")).toBeNull();
  });
});
