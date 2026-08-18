import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheet = new URL("../../src/styles.css", import.meta.url);
const documentTemplate = new URL("../../index.html", import.meta.url);

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
    expect(css).not.toMatch(/@keyframes composer-(?:breathe|settle|pulse)/);
    expect(css).not.toMatch(/\.composer--settled\b/);
  });

  it("keeps mobile edge insets and touch targets in the layout flow", async () => {
    const [css, html] = await Promise.all([
      readFile(stylesheet, "utf8"),
      readFile(documentTemplate, "utf8"),
    ]);
    expect(css).toMatch(/padding-top:\s*var\(--safe-top\)/);
    expect(css).toMatch(/padding-right:\s*var\(--safe-right\)/);
    expect(css).toMatch(/padding-bottom:\s*var\(--safe-bottom\)/);
    expect(css).toMatch(/padding-left:\s*var\(--safe-left\)/);
    expect(css).not.toMatch(/\.icon-button::after/);
    expect(css).toMatch(/\.pane-scrim\s*{[^}]*backdrop-filter:\s*blur\(2px\)/s);
    expect(html).toContain("viewport-fit=cover");
    expect(html).toContain("interactive-widget=resizes-content");
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
