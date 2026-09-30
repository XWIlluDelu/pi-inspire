#!/usr/bin/env node
// node scripts/benchmark-rich-text.mjs [rounds=3] [--baseline=<git-ref>]
// --baseline compiles that revision of RichText.tsx against current dependencies,
// without checking out or editing files (for a focused before/after comparison).
// Builds this worktree's real RichText with production React, then measures
// streamed updates in local headless Chromium. Output is JSON on stdout.
import { chromium } from "@playwright/test";
import express from "express";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const rounds = Number(process.argv[2] ?? 3);
if (!Number.isInteger(rounds) || rounds < 1)
  throw new Error("Expected positive rounds");
const baseline = process.argv[3]?.match(/^--baseline=([\w./-]+)$/)?.[1];
if (process.argv[3] && !baseline)
  throw new Error("Expected --baseline=<git-ref>");
const richTextPath = resolve("src/components/RichText.tsx");
const baselineSource = baseline
  ? execFileSync("git", ["show", `${baseline}:src/components/RichText.tsx`], {
      encoding: "utf8",
    })
  : undefined;
const outDir = resolve("output/rich-text-benchmark");
await build({
  configLoader: "runner",
  logLevel: "error",
  plugins: baselineSource
    ? [
        {
          name: "benchmark-rich-text-baseline",
          enforce: "pre",
          load(id) {
            return id === richTextPath ? baselineSource : undefined;
          },
        },
      ]
    : [],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: resolve("tests/fixtures/rich-text-benchmark.tsx"),
      output: { entryFileNames: "bench.js" },
    },
  },
});
const styles = (await readdir(resolve(outDir, "assets")))
  .filter((name) => name.endsWith(".css"))
  .map((name) => `<link rel="stylesheet" href="/assets/${name}">`)
  .join("");
await mkdir(outDir, { recursive: true });
await writeFile(
  resolve(outDir, "index.html"),
  `<!doctype html><html><head>${styles}</head><body><div id="root" style="width:800px"></div><script type="module" src="/bench.js"></script></body></html>`,
);
const server = express().use(express.static(outDir)).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(
    () => typeof window.benchmarkRichText === "function",
  );
  const semantics = await page.evaluate(() =>
    window.benchmarkRichTextSemantics(),
  );
  if (semantics.some((result) => !result.correct || !result.equivalent))
    throw new Error(`Markdown semantics failed: ${JSON.stringify(semantics)}`);
  const results = [];
  for (let round = 1; round <= rounds; round++) {
    for (const [kind, size] of [
      ["mixed", 16_000],
      ["mixed", 32_000],
      ["mixed", 64_000],
      ["mixed", 128_000],
      ["mixed", 256_000],
      ["plain", 64_000],
    ]) {
      const result = await page.evaluate(
        ([kind, size]) => window.benchmarkRichText(kind, size),
        [kind, size],
      );
      if (errors.length) throw new Error(errors.join("\n"));
      if (!result.equivalent) throw new Error("Streamed/fresh DOM differs");
      results.push({ round, ...result });
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    JSON.stringify(
      {
        browser: browser.version(),
        richTextRevision: baseline ?? "working-tree",
        warmups: 3,
        samples: 9,
        semantics,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
