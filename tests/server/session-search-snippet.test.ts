import { describe, expect, it } from "vitest";
import { sessionSearchSnippet } from "../../server/session-search-query.js";

const body =
  "We loaded fifty two calibration runs from the measurements folder and " +
  "noticed that the instrument resolution of 0.1 ms is far below the observed " +
  "jitter, so the gap between samples A and B is not an artefact of the clock.";

describe("sessionSearchSnippet", () => {
  it("cuts a bounded excerpt with the contiguous hit near its start", () => {
    const snippet = sessionSearchSnippet("resolution", body)!;
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(124);
    expect(snippet.toLowerCase().indexOf("resolution")).toBeLessThan(16);
  });

  it("prefers the longest literal term and honours quoted phrases", () => {
    expect(sessionSearchSnippet('jit "samples A and B"', body)).toContain(
      "samples A and B",
    );
  });

  it("uses regex matches and rejects invalid or empty patterns", () => {
    expect(sessionSearchSnippet("re:0\\.\\d ms", body)).toContain("0.1 ms");
    expect(sessionSearchSnippet("re:(", body)).toBeUndefined();
    expect(sessionSearchSnippet("re:", body)).toBeUndefined();
  });

  it("returns nothing for fuzzy-only or absent body matches", () => {
    expect(sessionSearchSnippet("clbrtn", body)).toBeUndefined();
    expect(sessionSearchSnippet("calibration", "")).toBeUndefined();
  });

  it("does not add ellipses when the whole short text fits", () => {
    expect(sessionSearchSnippet("cobalt", "Cobalt bands look fine.")).toBe(
      "Cobalt bands look fine.",
    );
  });

  it("reads Markdown as text and keeps a late match near the start", () => {
    const markdown =
      "```python\nx = 1\n```\nSee the [Pi documentation](https://pi.dev) for **details** on fit_params. Tightened the window normalization.";
    const snippet = sessionSearchSnippet("normalization", markdown)!;
    expect(snippet).not.toMatch(/```|\]\(|\*\*/u);
    expect(snippet.indexOf("normalization")).toBeLessThan(16);
    expect(sessionSearchSnippet("fit_params", markdown)).toContain(
      "fit_params",
    );
  });
});
