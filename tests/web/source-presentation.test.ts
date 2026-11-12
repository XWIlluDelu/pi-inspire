// @vitest-environment jsdom
import {
  FileArchive,
  FileCode2,
  FileImage,
  FileJson2,
  FileText,
} from "lucide-react";
import { describe, expect, it } from "vitest";
import type { GitDiffLine, GitDiffResponse } from "../../shared/contracts";
import { decodeTextPreview } from "../../shared/text-preview";
import { fileIconForPath } from "../../src/file-icons";
import { sourceDiffRows } from "../../src/source-diff";
import {
  highlightSourceLines,
  languageForFile,
} from "../../src/syntax-highlighting";

function diffFor(name: string, source: string[]) {
  let oldLine = 1;
  let newLine = 1;
  return {
    kind: "text",
    path: { id: name, display: name, utf8Path: name },
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

  it("renders sparse hunks literally if complete highlighting context no longer matches", () => {
    const diff = {
      ...diffFor("source.ts", ["-const old = 1;", "+const changed = 42;"]),
      contextLimited: true,
      source: {
        old: "/* a different revision",
        new: "/* a different revision",
      },
    };
    const { rows } = sourceDiffRows(diff);
    expect(code(rows[1].html).textContent).toBe("const changed = 42;");
    expect(rows[1].html).not.toContain("<span");
  });

  it("uses the original filename language for deleted renamed source", () => {
    const { rows } = sourceDiffRows(
      diffFor("renamed.txt", ["-const value = 42;", "+const value = 43;"]),
      "original.ts",
    );
    expect(rows[0].html).toContain("hljs-keyword");
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

describe("file presentation", () => {
  it.each([
    ["GNUmakefile", "makefile", FileCode2],
    ["src\\Panel.TSX", "tsx", FileCode2],
    ["config.JSON", "json", FileJson2],
    ["plot.svg", "svg", FileImage],
    ["bundle.tar.gz", "gz", FileArchive],
    ["folder.ts/LICENSE", "plaintext", FileText],
  ])(
    "uses the basename of %s for highlighting and icons",
    (path, language, Icon) => {
      expect(languageForFile(path)).toBe(language);
      expect(fileIconForPath(path)).toBe(Icon);
    },
  );

  it("balances multiline nested tokens into independently renderable rows", () => {
    const rows = highlightSourceLines('<div\n title="first\n second">', "html");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain('class="hljs-string"');
    for (const row of rows) {
      expect(row.match(/<span\b/g)?.length ?? 0).toBe(
        row.match(/<\/span>/g)?.length ?? 0,
      );
    }
    const rendered = document.createElement("span");
    rendered.innerHTML = rows[2]!;
    expect(rendered.textContent).toBe(' second">');
  });
});

const text = '$message = "你好 🌍"\r\nWrite-Output $message\r\n';

function unicodeBytes(
  text: string,
  encoding: "utf-8" | "utf-16le" | "utf-16be",
): Uint8Array<ArrayBuffer> {
  if (encoding === "utf-8") return new TextEncoder().encode(text);
  const bytes = new Uint8Array(2 + text.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, encoding === "utf-16le");
  for (let index = 0; index < text.length; index++)
    view.setUint16(
      2 + index * 2,
      text.charCodeAt(index),
      encoding === "utf-16le",
    );
  return bytes;
}

describe("bounded Unicode file text", () => {
  it.each(["utf-8", "utf-16le", "utf-16be"] as const)(
    "decodes %s and suppresses a partial trailing character at a transfer cap",
    (encoding) => {
      expect(decodeTextPreview(unicodeBytes(text, encoding))).toBe(text);
      const bytes = unicodeBytes("first 🌍", encoding);
      const partial = bytes.subarray(0, bytes.length - 1);
      expect(decodeTextPreview(partial, true)).toBe("first ");
      expect(decodeTextPreview(partial)).toContain("�");
    },
  );

  it("keeps BOM-less input UTF-8 and removes the UTF-8 BOM", () => {
    expect(
      decodeTextPreview(
        new Uint8Array([0xef, 0xbb, 0xbf, ...unicodeBytes(text, "utf-8")]),
      ),
    ).toBe(text);
    expect(decodeTextPreview(new Uint8Array([0xff]))).toBe("�");
    expect(decodeTextPreview(new Uint8Array())).toBe("");
  });
});
