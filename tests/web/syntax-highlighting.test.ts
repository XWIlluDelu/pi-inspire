import { describe, expect, it } from "vitest";
import {
  highlightSource,
  highlightSourceLines,
  languageForFile,
} from "../../src/syntax-highlighting";

describe("source highlighting", () => {
  it.each([
    ["Makefile", "build:\n\techo ok", "hljs-section"],
    ["GNUmakefile", "build:\n\techo ok", "hljs-section"],
    ["src/Panel.TSX", "export const value: number = 42", "hljs-keyword"],
    ["entry.mjs", "export const value = 42", "hljs-number"],
    ["config.yml", "enabled: true", "hljs-attr"],
    ["train.py", "print('ready')", "hljs-built_in"],
  ])("recognizes %s without guessing from content", (name, source, token) => {
    expect(highlightSource(source, languageForFile(name))).toContain(token);
  });

  it("balances multiline nested tokens into independently renderable rows", () => {
    const rows = highlightSourceLines('<div\n title="first\n second">', "html");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain('class="hljs-string"');
    for (const row of rows) {
      expect(row.match(/<span\b/g)?.length ?? 0).toBe(
        row.match(/<\/span>/g)?.length ?? 0,
      );
    }
    expect(rows[2]).toMatch(
      /^<span class="hljs-tag"><span class="hljs-string">/,
    );
  });

  it("keeps unknown and oversized source escaped", () => {
    const unsafe = '<script title="x">&</script>';
    expect(highlightSource(unsafe, "not-a-language")).toBe(
      "&lt;script title=&quot;x&quot;&gt;&amp;&lt;/script&gt;",
    );
    const large = `${" ".repeat(64 * 1024)}${unsafe}`;
    expect(highlightSource(large, "html")).not.toContain("<");
  });
});
