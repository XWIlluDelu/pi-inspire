import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheet = new URL("../../src/styles.css", import.meta.url);
async function readStylesheet(
  url = stylesheet,
  seen = new Set<string>(),
): Promise<string> {
  if (seen.has(url.href)) return "";
  seen.add(url.href);
  const css = await readFile(url, "utf8");
  const imports = [...css.matchAll(/@import\s+["']([^"']+\.css)["'];/g)];
  const dependencies = await Promise.all(
    imports.map((match) => readStylesheet(new URL(match[1]!, url), seen)),
  );
  return [css, ...dependencies].join("\n");
}

describe("static asset contracts", () => {
  it("keeps stroke compatibility names as single aliases of canonical colors", async () => {
    const css = await readStylesheet();
    expect([...css.matchAll(/--hairline\s*:/g)]).toHaveLength(1);
    expect([...css.matchAll(/--hairline-strong\s*:/g)]).toHaveLength(1);
    expect(css).toMatch(/--hairline\s*:\s*var\(--line\)/);
    expect(css).toMatch(/--hairline-strong\s*:\s*var\(--line-strong\)/);
    expect(css).not.toMatch(
      /--(?:line|hairline)(?:-strong)?\s*:\s*\d+(?:\.\d+)?px/,
    );
  });

  it("loads the opt-in native choice skin with keyboard focus and high-contrast recovery", async () => {
    const css = await readStylesheet();
    expect(css).toMatch(/\.choice-input\s*\{[^}]*appearance:\s*none/);
    expect(css).toMatch(/\.choice-input:focus-visible\s*\{[^}]*outline:/);
    expect(css).toMatch(
      /@media\s*\(forced-colors:\s*active\)\s*\{\s*\.choice-input\s*\{\s*appearance:\s*auto/,
    );
  });

  it("does not reference undeclared project CSS variables", async () => {
    const css = await readStylesheet();
    const declared = new Set(
      [...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]),
    );
    // These controls supply their option/visible-key counts inline.
    for (const owner of ["SettingsControls", "TerminalTouchKeys"]) {
      const source = await readFile(
        new URL(`../../src/components/${owner}.tsx`, import.meta.url),
        "utf8",
      );
      for (const match of source.matchAll(/["']--([a-z0-9-]+)["']\s*:/gi))
        declared.add(match[1]);
    }
    const referenced = new Set(
      [...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]),
    );
    expect(
      [...referenced].filter((name) => !declared.has(name)).sort(),
    ).toEqual([]);
  });
});
