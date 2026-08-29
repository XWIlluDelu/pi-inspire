import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheet = new URL("../../src/styles.css", import.meta.url);
const launcherIcons = [
  new URL("../../public/app-icon-192.png", import.meta.url),
  new URL("../../public/app-icon-512.png", import.meta.url),
];

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
    const declared = new Set(
      [...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]),
    );
    const referenced = new Set(
      [...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]),
    );
    expect(
      [...referenced].filter((name) => !declared.has(name)).sort(),
    ).toEqual([]);
  });

  it("keeps ordinary launcher icons alpha-capable at their rounded corners", async () => {
    for (const icon of launcherIcons) {
      const png = await readFile(icon);
      expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
      expect(png[25]).toBe(6);
    }
  });
});
