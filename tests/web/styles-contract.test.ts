import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheet = new URL("../../src/styles.css", import.meta.url);

describe("design token contract", () => {
  it("does not reference undeclared project CSS variables", async () => {
    const css = await readFile(stylesheet, "utf8");
    const declared = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
    const referenced = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]));
    expect([...referenced].filter((name) => !declared.has(name)).sort()).toEqual([]);
  });
});
