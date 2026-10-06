# Performance and measurement

## Performance evidence

### Draft and History work

Linux / Node 26.10.0, baseline `34b796bb444a`. Initial draft hydration plus 200 edits changed
sessionStorage reads from 201 to one. Composer history over 5,000 distinct user messages retained
the same newest 100 entries while reducing counted content-property reads from 10,000 to 202.
Sources: `src/session-drafts.ts`, `server/composer-history.ts` and their focused regression tests.
These are work counts, not typing-latency measurements.

Paired production `projectSessionTree()` measurements used 5,000 alternating user/assistant entries,
85,065,000 retained text characters and at most 100 returned rows. After warming both implementations,
12 samples alternated execution order; serialized projections were equal before timing.

| Operation | Before median, ms | After median, ms |
| --- | ---: | ---: |
| Ordinary outline | 4.370 | 0.784 |
| Matching full-text search | 42.780 | 39.258 |
| Nonmatching full-text search | 31.273 | 30.191 |

Structural snapshot indexes and bounded lazy snippets remove most ordinary outline work. Search
still scans retained text synchronously; its improvement is modest. These timings cover projection,
not file I/O, HTTP, network or rendering. Source: `server/session-tree.ts`; integrated review:
[[state-ownership]]. No timing thresholds were added to tests.

### Pi 1.0 source and catalog profiles

Local production Chromium at 1440×900 reproduced synchronous source-highlighting cost. A
1,500-line / 193,500-character TypeScript source generated 21,000 spans; repeated opens produced
highlighting/layout task pairs of 66+195 ms and 59+191 ms. With the per-leaf highlight budget reduced
to 64 Ki characters, neither open produced a task above 50 ms. The actual 105,793-character
`src/store.ts` changed from a 105 ms task to none above 50 ms; a 64,500-character source still
highlighted. Larger leaves retain plain text and copying. Source: `src/syntax-highlighting.ts`.

The desktop/390px native fixture held 1,537 catalog / 1,080 available models and mounted at most 12
picker/grid rows while passing distant navigation, search and overflow checks. This demonstrates
bounded mounting/interaction, not model-query latency.

A 16,795,320-byte Host projection fixture took median 7.248 ms forced versus 0.022 ms
version-checked. A separate 20,000-entry / approximately 41 MiB History fixture returned 100-node /
approximately 77 KiB pages: outline work took 6.7–13.8 ms and full-text search 20.3–25.7 ms over five
runs. These are local synthetic projection measurements, not remote end-to-end timings. Boundaries:
[[state-ownership]], [[performance]]. No further optimization followed.

### Settings shell continuity

A production Chromium probe found two Settings dialog nodes and two starts of both entrance
animations on first open: Suspense fallback and ready content each owned an animated shell.
Subsequent opens reused the module. The eager `SettingsDialog` now owns overlay, header and focus;
only its content is deferred.

A fresh context with service workers blocked and the module delayed 600 ms checked 1280×720/light
and 390×844/dark: one shell, one start per animation, and opacity 1 throughout readiness. Injected
module-evaluation failure preserved that dialog and Reload; Escape restored its opener.
`tests/web/settings-loading.test.tsx` covers loading dismissal, stable shell/control identities and
focus continuity. This is transition correctness, not startup-latency evidence.

### Streaming work counters

`tests/server/runtime-stream-budget.test.ts` compares the real reducer/overlay with incremental
accounting disabled and enabled. For 1,000/2,000 alternating 32-character text/thinking fragments,
the old path serialized cumulative messages 1,000/2,000 times and approximately 16.2/64.4 MB of JSON.
The incremental path produces identical overlays using 34/68 KB of fragment JSON and no cumulative
message serialization in that hot path. Escapes, split surrogates, revision growth, budgets,
structural fallback and final/snapshot validation remain covered. These are work counters, not
network, peak-memory or latency measurements. Tool-argument wire evidence: [[workbench-implementation]].

## Rich rendering performance

### Where the work runs

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

### Measurement method

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

### Generated-leaf reuse

The leaf-only comparison used the benchmark and fixture at `62f16e53842f`, before background parsing and
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

### Background parsing

```sh
mkdir -p output
node scripts/benchmark-rich-text.mjs 3 --baseline=2646443ffc24 > output/rich-text-leaf-only.json
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

## Session-scale evidence

Persisted entries, active-branch projections and child RPC frames have different size distributions. Bound them independently.

These are observations, not limits to encode. Histories keep growing, and one tool result can make a future entry larger. The durable boundary is structural:

- Initial projection reads the session file incrementally and bounds each persisted line independently from total history size.
- Browser transcript pages are bounded by serialized bytes as well as item count; virtualization bounds mounted DOM, not transfer or retention.
- Pi RPC `get_entries { since }` is suitable only after a trusted baseline cursor exists, because an initial response still aggregates the whole append-order history into one JSONL frame.
- The malformed or unterminated child-output guard stays independent and fatal; a legitimate long history must avoid the aggregate `get_messages` path rather than receive a larger exception.

The measurement streamed each file to obtain complete-line sizes, then used `SessionManager.open`, `getEntries`, `getLeafId`, and `buildSessionContext` to serialize the active branch. The current code boundaries are `server/pi-rpc.ts`, `server/session-preview.ts`, `server/runtime.ts`, `shared/contracts.ts`, and `server/app.ts`.
