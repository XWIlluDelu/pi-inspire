import { readFile } from "node:fs/promises";

const css = await readFile(
  new URL("../../src/styles/foundation.css", import.meta.url),
  "utf8",
);

const blocks = [
  ...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((match) => ({
  selectors: match[1]!
    .trim()
    .split(",")
    .map((s) => s.trim()),
  values: Object.fromEntries(
    [...match[2]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1]!,
      m[2]!.trim(),
    ]),
  ),
}));

export function paletteTokens(
  palette: string,
  theme: string,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const block of blocks) {
    if (
      block.selectors.some(
        (selector) =>
          /^:root(?:\[data-(?:palette|theme)="[\w-]+"\])*$/.test(selector) &&
          [...selector.matchAll(/\[data-(palette|theme)="([^"]+)"\]/g)].every(
            (m) => m[2] === (m[1] === "theme" ? theme : palette),
          ),
      )
    )
      Object.assign(values, block.values);
  }
  const resolve = (value: string): string =>
    value.replace(/var\((--[\w-]+)\)/g, (_, key) => resolve(values[key]!));
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, resolve(value)]),
  );
}
