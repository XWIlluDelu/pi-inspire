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

function declaredVariables(css: string): Set<string> {
  // A declaration starts a block or follows a semicolon. BEM selectors such as
  // .button--danger:hover are not custom-property declarations.
  const declarations = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/(?:^|[;{])\s*--([a-z0-9-]+)\s*:/gim);
  return new Set([...declarations].map((match) => match[1]!));
}

describe("static asset contracts", () => {
  it("distinguishes custom properties from BEM selectors and comments", () => {
    const css = `
      /* --danger: red; */
      :root { --accent: blue; --accent-focus: var(--accent); }
      .button--danger:hover { color: var(--danger); }
    `;
    expect([...declaredVariables(css)]).toEqual(["accent", "accent-focus"]);
  });

  it("does not reference undeclared project CSS variables", async () => {
    const css = (await readStylesheet()).replace(/\/\*[\s\S]*?\*\//g, "");
    const declared = declaredVariables(css);
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
