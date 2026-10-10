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

  it("lets CodeMode call lists use conversation scrolling instead of a capped inner viewport", async () => {
    const css = await readStylesheet();
    const rule = css.match(
      /\.tool-call-layout--codemode\s+\.child-calls\s*\{([^}]*)\}/,
    )?.[1];
    expect(rule).toMatch(/max-height:\s*none/);
    expect(rule).toMatch(/overflow:\s*visible/);
  });

  it("loads the opt-in native choice skin with keyboard focus and high-contrast recovery", async () => {
    const css = await readStylesheet();
    expect(css).toMatch(/\.choice-input\s*\{[^}]*appearance:\s*none/);
    expect(css).toMatch(/\.choice-input:focus-visible\s*\{[^}]*outline:/);
    expect(css).toMatch(
      /@media\s*\(forced-colors:\s*active\)\s*\{\s*\.choice-input\s*\{\s*appearance:\s*auto/,
    );
  });

  it("aligns task markers independently of checked glyph baselines", async () => {
    const css = await readStylesheet();
    const taskSkin = css.match(
      /\.rich-text\s+\.contains-task-list\s+input\[type="checkbox"\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(css).toMatch(/\.choice-input\s*\{[^}]*display:\s*inline-block/);
    expect(css).toMatch(
      /\.choice-input:checked::before\s*\{[^}]*position:\s*absolute/,
    );
    expect(taskSkin).toMatch(/vertical-align:\s*-0\.15em/);
    expect(taskSkin).toMatch(/opacity:\s*1/);
  });

  it("puts the file-picker search boundary on the complete controls row", async () => {
    const css = await readStylesheet();
    expect(css).toMatch(
      /\.picker > \.file-search-controls\s*\{[^}]*border-bottom:\s*1px solid var\(--hairline\)/,
    );
    expect(css).toMatch(
      /\.picker > \.file-search-controls:has\(\.picker__input:focus\)\s*\{[^}]*border-bottom-color:\s*var\(--accent\)/,
    );
    const input = css.match(/\.picker__input\s*\{([^}]*)\}/)?.[1];
    expect(input).not.toMatch(/border-bottom:/);
  });

  it("marks file-picker directory captions without adding to path values", async () => {
    const css = await readStylesheet();
    expect(css).toMatch(/\.picker__path\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.picker__path::before\s*\{[^}]*content:\s*"@"/);
  });

  it("reserves tree disclosure space for file leaves without indenting search results", async () => {
    const css = await readStylesheet();
    const slot = css.match(
      /\.workspace-tree__row--file:not\(\.workspace-tree__row--result\)::before\s*\{([^}]*)\}/,
    )?.[1];
    expect(slot).toMatch(/content:\s*""/);
    expect(slot).toMatch(/flex:\s*0 0 11px/);
  });

  it("does not reference undeclared project CSS variables", async () => {
    const css = await readStylesheet();
    const controls = await readFile(
      new URL("../../src/components/SettingsControls.tsx", import.meta.url),
      "utf8",
    );
    const declared = new Set(
      [...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]),
    );
    // Choice controls supply their option count as an inline CSS property.
    for (const match of controls.matchAll(/["']--([a-z0-9-]+)["']\s*:/gi))
      declared.add(match[1]);
    const referenced = new Set(
      [...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]),
    );
    expect(
      [...referenced].filter((name) => !declared.has(name)).sort(),
    ).toEqual([]);
  });
});
