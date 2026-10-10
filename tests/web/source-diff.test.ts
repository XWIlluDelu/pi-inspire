// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { GitDiffLine, GitDiffResponse } from "../../shared/contracts";
import { sourceDiffRows } from "../../src/source-diff";

function diffFor(name: string, source: string[]) {
  let oldLine = 1;
  let newLine = 1;
  return {
    kind: "text",
    path: { id: name, display: name, utf8Path: name },
    side: "unstaged",
    additions: source.filter((line) => line.startsWith("+")).length,
    deletions: source.filter((line) => line.startsWith("-")).length,
    truncated: false,
    encodingLossy: false,
    lines: source.map((text): GitDiffLine => {
      const kind = text.startsWith("+")
        ? "add"
        : text.startsWith("-")
          ? "delete"
          : text.startsWith(" ")
            ? "context"
            : "hunk";
      return {
        kind,
        text,
        oldLine: kind === "context" || kind === "delete" ? oldLine++ : null,
        newLine: kind === "context" || kind === "add" ? newLine++ : null,
      };
    }),
  } satisfies GitDiffResponse;
}

function code(html: string) {
  const element = document.createElement("code");
  element.innerHTML = html;
  return element;
}

describe("Changes source projection", () => {
  it("highlights multiline old/new revisions independently and uses new context semantics", () => {
    const diff = diffFor("source.ts", [
      "@@ -1,4 +1,4 @@",
      "-/* old comment",
      "+const value = 1;",
      " shared()",
      "-*/",
      "+const label = 'new';",
      " done()",
    ]);
    const { rows, changes } = sourceDiffRows(diff);
    expect(code(rows[0].html).querySelector(".hljs-comment")).not.toBeNull();
    expect(code(rows[3].html).querySelector(".hljs-comment")).not.toBeNull();
    expect(code(rows[1].html).querySelector(".hljs-keyword")).not.toBeNull();
    expect(code(rows[2].html).querySelector(".hljs-comment")).toBeNull();
    expect(code(rows[4].html).querySelector(".hljs-string")).not.toBeNull();
    expect(changes).toBe(2);
    expect(rows.map((row) => row.changeIndex)).toEqual([
      0,
      0,
      null,
      1,
      1,
      null,
    ]);
    expect(rows.filter((row) => row.startsChange)).toHaveLength(2);
    rows.forEach((row) =>
      expect(code(row.html).textContent).toBe(row.line.text.slice(1)),
    );
  });

  it("uses the original filename language for deleted renamed source", () => {
    const { rows } = sourceDiffRows(
      diffFor("renamed.txt", ["-const value = 42;", "+const value = 43;"]),
      "original.ts",
    );
    expect(rows[0].html).toContain("hljs-keyword");
    expect(rows[1].html).not.toContain("<span");
  });

  it.each(["page.html", "unknown.fixture"])(
    "keeps escaped %s source literal and safe",
    (name) => {
      const text = '<script title="x">&</script>  <img onerror="bad()">';
      const { rows } = sourceDiffRows(diffFor(name, [`+${text}`]));
      const element = code(rows[0].html);
      expect(element.textContent).toBe(text);
      expect(element.querySelector("script, img")).toBeNull();
    },
  );

  it("applies the existing size bound per revision, not per diff row", () => {
    const { rows } = sourceDiffRows(
      diffFor("source.ts", [
        `-${" ".repeat(64 * 1024)}<old>&`,
        "+const small = 42;",
        " const shared = 1;",
      ]),
    );
    expect(rows[0].html).not.toContain("<span");
    expect(code(rows[0].html).textContent).toBe(rows[0].line.text.slice(1));
    expect(rows[1].html).toContain("hljs-keyword");
    expect(rows[2].html).toContain("hljs-keyword");
  });
});
