import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheet = new URL("../../src/styles.css", import.meta.url);

describe("design token contract", () => {
  it("does not reference undeclared project CSS variables", async () => {
    const css = await readFile(stylesheet, "utf8");
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

  it("keeps navigation run outcomes on distinct traffic-light tokens", async () => {
    const css = await readFile(stylesheet, "utf8");
    expect(css).toMatch(/\.nav__row-dot--running\s*{[^}]*animation:\s*spin/s);
    expect(css).toMatch(
      /\.nav__row-dot--completed\s*{[^}]*background:\s*var\(--success\)/s,
    );
    expect(css).toMatch(
      /\.nav__row-dot--failed\s*{[^}]*background:\s*var\(--error\)/s,
    );
    expect(css).not.toMatch(/@keyframes dot-breathe/);
    expect(css).not.toMatch(/@keyframes chip-breathe/);
    expect(css).not.toMatch(/@keyframes composer-breathe/);
    expect(css).not.toMatch(/@keyframes composer-settle/);
  });

  it("declares permanent brand and dedicated surface tokens", async () => {
    const css = await readFile(stylesheet, "utf8");
    expect(css).toMatch(/--brand-accent\s*:/);
    expect(css).toMatch(/--brand-ink\s*:/);
    expect(css).toMatch(/--bg-prompt\s*:/);
    expect(css).toMatch(/--bg-activity\s*:/);
    expect(css).toMatch(/--bg-code\s*:/);
    expect(css).toMatch(/--bg-control\s*:/);
    expect(css).toMatch(/--activity-tool\s*:/);
    expect(css).toMatch(/--activity-think\s*:/);
  });
});
