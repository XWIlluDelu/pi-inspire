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
