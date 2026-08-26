import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheet = new URL("../../src/styles.css", import.meta.url);
const documentTemplate = new URL("../../index.html", import.meta.url);
const launcherIcons = [
  new URL("../../public/app-icon-192.png", import.meta.url),
  new URL("../../public/app-icon-512.png", import.meta.url),
];

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

  it("keeps ordinary launcher icons alpha-capable at their rounded corners", async () => {
    for (const icon of launcherIcons) {
      const png = await readFile(icon);
      expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
      // PNG IHDR byte 9 is the color type; 6 is truecolor with alpha.
      expect(png[25]).toBe(6);
    }
  });

  it("declares permanent brand and dedicated surface tokens", async () => {
    const css = await readFile(stylesheet, "utf8");
    expect(css).toMatch(/--brand-accent\s*:/);
    expect(css).toMatch(/--brand-ink\s*:/);
    expect(css).toMatch(/--bg-prompt\s*:/);
    expect(css).toMatch(/--bg-activity\s*:/);
    expect(css).toMatch(/--bg-code\s*:/);
    expect(css).toMatch(/--bg-control\s*:/);
    expect(css).toMatch(/--bg-file-canvas\s*:/);
    expect(css).toMatch(/--bg-file-surface\s*:/);
    expect(css).toMatch(/--bg-file-inset\s*:/);
    expect(css).toMatch(/--activity-tool\s*:/);
    expect(css).toMatch(/--activity-think\s*:/);
  });

  it("keeps file content canvases neutral across palettes", async () => {
    const css = await readFile(stylesheet, "utf8");
    for (const token of [
      "bg-file-canvas",
      "bg-file-surface",
      "bg-file-inset",
    ]) {
      expect([
        ...css.matchAll(new RegExp(`--${token}\\s*:`, "g")),
      ]).toHaveLength(2);
    }
    expect(css).toMatch(
      /\.file-preview__content,\s*\.changes__content\s*{[^}]*--bg-context:\s*var\(--bg-file-canvas\)[^}]*--bg-surface:\s*var\(--bg-file-surface\)[^}]*--bg-inset:\s*var\(--bg-file-inset\)[^}]*background:\s*var\(--bg-file-canvas\)/s,
    );
  });

  it("keeps card controls separate while summaries use the remaining header width", async () => {
    const css = await readFile(stylesheet, "utf8");
    expect(css).toMatch(
      /\.card__disclosure:has\(\+ \.card__summary\)\s*{[^}]*flex:\s*0 0 auto[^}]*max-width:\s*min\(50%, 32ch\)/s,
    );
    expect(css).toMatch(
      /\.card__label\s*{[^}]*flex:\s*0 1 auto[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
    );
    expect(css).toMatch(/\.card__summary--tool\s*{[^}]*max-width:\s*none/s);
    expect(css).toMatch(
      /\.tool-summary__separator\s*{[^}]*white-space:\s*pre/s,
    );
  });

  it("fits measured resource paths while block paths use the remaining row", async () => {
    const css = await readFile(stylesheet, "utf8");
    expect(css).toMatch(
      /\.resource-path\s*{[^}]*display:\s*block[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/s,
    );
    expect(css).toMatch(
      /\.resource-path__visible\s*{[^}]*display:\s*block[^}]*overflow:\s*hidden[^}]*white-space:\s*nowrap/s,
    );
    expect(css).toMatch(
      /\.resource-path__measure\s*{[^}]*position:\s*absolute[^}]*width:\s*max-content[^}]*visibility:\s*hidden/s,
    );
    expect(css).toMatch(
      /\.tool-block__heading\s*{[^}]*justify-content:\s*flex-start[^}]*gap:\s*var\(--space-2\)/s,
    );
    expect(css).toMatch(
      /\.tool-block__heading\s*>\s*span\s*{[^}]*flex:\s*0 0 auto[^}]*white-space:\s*nowrap/s,
    );
    expect(css).toMatch(/\.tool-block__path\s*{[^}]*flex:\s*1 1 0/s);
  });

  it("scopes reading presets to content typography and the shared reading measure", async () => {
    const css = await readFile(stylesheet, "utf8");
    expect(css).toMatch(
      /:root\[data-content-text-size="compact"\]\s*{[^}]*--text-reading:\s*14px/s,
    );
    expect(css).toMatch(
      /:root\[data-content-text-size="large"\]\s*{[^}]*--text-reading:\s*17px/s,
    );
    expect(css).toMatch(
      /\.user-bubble\s*{[^}]*font-size:\s*var\(--text-reading\)/s,
    );
    expect(css).toMatch(
      /\.code-block__pre\s*{[^}]*font-size:\s*var\(--text-reading-code\)/s,
    );
    expect(css).toMatch(
      /\.composer__input\s*{[^}]*font-size:\s*var\(--text-reading\)/s,
    );
    expect(css).toMatch(
      /\.card__body\s*{[^}]*font-size:\s*var\(--text-reading-small\)/s,
    );
    expect(css).toMatch(
      /\.tool-code,\s*\.tool-terminal,\s*\.tool-text\s*{[^}]*font-size:\s*var\(--text-reading-code\)/s,
    );
    expect(css).toMatch(
      /\.source-diff\s*{[^}]*font:\s*var\(--text-reading-code\)\/var\(--leading-mono\) var\(--font-mono\)/s,
    );
    expect(css).toMatch(
      /:root\[data-reading-width="narrow"\]\s*{[^}]*--reading-width-max:\s*680px/s,
    );
    expect(css).toMatch(
      /:root\[data-reading-width="wide"\]\s*{[^}]*--reading-width-max:\s*980px/s,
    );
    expect(css).toMatch(/--content-max:\s*var\(--reading-width-max\)/);
    expect(css).toMatch(/--composer-max:\s*var\(--reading-width-max\)/);
    expect(css).toMatch(
      /\.settings\s+\.segmented\s*{[^}]*display:\s*inline-grid[^}]*grid-auto-columns:\s*minmax\(0, 1fr\)/s,
    );
    expect(css).toMatch(
      /\.settings\s+\.segmented__item\s*{[^}]*min-width:\s*0/s,
    );
  });

  it("preserves user prompt line breaks, bounds token-gate controls, and keeps composer spacers elastic", async () => {
    const css = await readFile(stylesheet, "utf8");
    expect(css).toMatch(
      /\.rich-text--user\s+p,\s*\.rich-text--user\s+li\s*{[^}]*white-space:\s*pre-wrap/s,
    );
    expect(css).toMatch(
      /\.token-gate\s+form\s*{[^}]*width:\s*100%[^}]*max-width:\s*100%/s,
    );
    expect(css).toMatch(
      /\.token-gate\s+input\s*{[^}]*flex:\s*1\s+1\s+0[^}]*width:\s*0[^}]*min-width:\s*0/s,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*600px\)[\s\S]*?\.composer__spacer\s*{[^}]*flex:\s*1\s+1\s+0/s,
    );
    expect(css).toMatch(
      /\.model-picker__trigger-copy\s*{[^}]*flex:\s*1\s+1\s+auto[^}]*overflow:\s*hidden/s,
    );
    expect(css).toMatch(/\.model-picker__trigger\s*{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(
      /\.model-picker__trigger-copy\s*>\s*\.dropdown__value\s*{[^}]*width:\s*100%[^}]*max-width:\s*none/s,
    );
  });
});
