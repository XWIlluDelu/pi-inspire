---
purpose: Rich-rendering performance rationale and reproducible production-browser measurements.
---

# Rich rendering performance

## Where the work runs

Whole-document Markdown parsing preserves late references, footnotes, and changing open blocks.
The renderer addresses its cost in two ways:

- `rich-text-parser.ts` parses large sources in a shared worker. The client keeps one active job
  overall and only the latest queued source per reader; compatible prefixes stay formatted while
  new text appears immediately. HAST-to-React conversion and layout remain on the main thread.
- `RichTextMath` and `CodeBlock` reuse unchanged formulas and highlighted code through primitive
  expression/mode and source/language props. Reuse follows source-safety and sanitization, stays
  scoped to mounted content, and survives unrelated text updates or clipboard feedback.

Vite and the benchmark select Micromark's official table-backed entity decoder: its default browser
implementation requires `document` and cannot run in a worker. A worker failure reaches the readable
error boundary rather than repeating the large parse on the input thread. Current contract:
[[rich-rendering]].

## Measurement method

`scripts/benchmark-rich-text.mjs` builds the actual component with production React and project CSS,
serves it on a loopback port, and uses headless Chromium. `--baseline` compiles that Git revision of
`RichText.tsx` against the same current dependencies, styles, and fixture.

Each case mounts a completed prefix, waits for fonts, then appends a short tail over twelve updates:
three warmups and nine measured samples per round. Measurements separate the immediate React
render/commit, forced layout, and time until complete rich rendering. Animation-frame gaps span the
update through formatting completion. These are mounted-component measurements, not network or
initial-loading timings. Every case compares streamed DOM with a fresh complete-source render.

Both comparisons below used React 19.2.7, Chromium 151.0.7922.34, and three rounds. Values are medians
of round medians; brackets give their range. Mixed content repeats prose, lists, tables, links,
inline/display mathematics, and highlighted TypeScript.

## Generated-leaf reuse

The leaf-only comparison used the benchmark and fixture at `cd3213e`, before background parsing and
the newer semantic prechecks. Both columns measured synchronous render/commit.

| ASCII source bytes | Before render/commit | After leaf reuse | Before / after through layout |
| --- | ---: | ---: | ---: |
| Mixed 16,074 | 31.0 [29.4–32.3] ms | 10.9 [9.8–13.1] ms | 32.3 / 11.1 ms |
| Mixed 32,148 | 63.9 [60.9–64.9] ms | 19.7 [19.0–23.1] ms | 65.8 / 20.1 ms |
| Mixed 64,296 | 130.2 [126.2–130.6] ms | 42.2 [40.5–43.2] ms | 134.0 / 43.0 ms |
| Plain 64,262 | 10.4 [10.4–10.4] ms | 10.5 [10.4–10.7] ms | 10.5 / 10.6 ms |

Mixed-content cost fell 65–69%; plain-text cost stayed unchanged. Work-counter tests recorded zero
KaTeX/highlighter calls across twenty trailing-text updates over three stable formulas and two code
blocks. Changing one expression and one code block invoked each renderer once.

## Background parsing

```sh
mkdir -p output
node scripts/benchmark-rich-text.mjs 3 --baseline=1626a69 > output/rich-text-leaf-only.json
node scripts/benchmark-rich-text.mjs 3 > output/rich-text-worker.json
```

The leaf-only baseline uses the last pre-worker `RichText.tsx` source. Background parsing changes
where work runs: new text appears immediately, while complete formatting follows the worker result.

| Mixed characters | Immediate update, before → after | Largest frame gap, before → after | Full rich latency, before → after |
| --- | ---: | ---: | ---: |
| 64,296 | 42.1 → 0.2 ms | 49.5 → 17.6 ms | 50.3 → 65.6 ms |
| 128,169 | 87.4 → 0.3 ms | 98.9 → 17.8 ms | 100.8 → 116.9 ms |
| 256,338 | 184.5 → 0.4 ms | 208.6 → 27.2 ms | 212.2 → 228.2 ms |

Parsing still scales with source size. Changed math/code leaves, React conversion, and layout remain
main-thread costs; the table distinguishes reduced input-thread blocking from full formatting latency.

## Correctness evidence

- `tests/web/rich-text{,-streaming,-worker}.test.tsx` covers unlabeled/indented/incomplete fences,
  whitespace and source copy, inline references, delimiter-crossing updates, late/duplicate references,
  footnotes, loose lists, tables, setext headings, math, and sanitization.
- `tests/web/rich-text-parser-client.test.ts` covers latest-source coalescing, reader retirement, and
  worker failure. The benchmark also checks complete-source DOM equality and Markdown semantics.
- Chromium flows in `tests/browser/tool-presentations.spec.ts` and `filesystem-files.spec.ts` exercise
  rapid large-response updates alongside composer typing, document-local images, and heading navigation.
