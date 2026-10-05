# Performance and measurement

## Performance evidence

### Pi 1.0 source and catalog profiles

Local production Chromium at 1440×900 reproduced synchronous source highlighting cost. A
1,500-line / 193,500-character TypeScript source generated 21,000 spans; two repeated opens
produced highlighting/layout task pairs of 66+195 ms and 59+191 ms. After lowering the per-leaf
highlight budget to 64 Ki characters, repeated opens produced no task above 50 ms. The actual
105,793-character `src/store.ts` changed from a 105 ms task to none above 50 ms; a 64,500-character
source still highlighted. Larger leaves remain plain text with copying, not omitted content.
Source: `src/syntax-highlighting.ts`; integrated outcome: .

The desktop/390px native catalog fixture held 1,537 catalog / 1,080 available models, mounted at
most 12 picker/grid rows, and passed distant navigation, search and overflow checks. This is a
bounded mounting/interaction witness, not a model-query latency measurement.

Host probes retained the existing unchanged-read reuse design: a 16,795,320-byte fixture took
median 7.248 ms forced versus 0.022 ms version-checked. A separate 20,000-entry / approximately
41 MiB History fixture returned 100-node / approximately 77 KiB pages; outline work took
6.7–13.8 ms and full-text search 20.3–25.7 ms over five runs. These are local synthetic projection
measurements, not remote end-to-end timings. Current boundaries: [[state-ownership]]
and [[performance]]. No additional Host/remote optimization followed from these profiles.

### Settings first-open flash

A Chromium production-build probe reproduced two distinct Settings dialog nodes
and two starts each of `overlay-in` and `pop-in` during the first open: the
Suspense loading fallback and ready component each mounted their own animated
shell. Subsequent opens reused the loaded module, explaining the cold-open bias.

The eager `SettingsDialog` now owns the overlay, header, and modal focus while
only `SettingsContent` is deferred. A fresh browser context with service workers
blocked and the Settings module response delayed by 600 ms verified the fix at
1280×720/light and 390×844/dark: one shell, one start per entrance animation,
and overlay opacity remaining 1 after the initial entrance through readiness.
An injected module-evaluation failure preserved the same dialog and Reload
control; Escape closed it and restored the opener. This is transition-correctness
evidence, not a general startup-latency benchmark.

`tests/web/settings-loading.test.tsx` gates the real lazy import and checks
loading-state dismissal, stable overlay/dialog/close-button identities, focus
continuity on readiness, and final opener restoration. Navigation, modal-focus,
and App integration checks also pass (35 tests across the four targeted files,
on both Node 26.5.0 and Node 22.23.2). Typecheck, production Web build, formatting,
lint, and unused-code checks pass.

### Targeted streaming work counters

The review identified two concrete costs outside the older evaluator's limited stream scenario: background body delivery before browser filtering, and cumulative assistant overlay serialization on every valid delta. The user explicitly requested these targeted changes; the historical no-change decisions below do not forbid them or establish their latency benefit.

`tests/server/runtime-stream-budget.test.ts` drives the real event reducer and overlay owner with alternating 32-character text/thinking fragments. With incremental accounting disabled, 1,000/2,000 updates serialize cumulative assistant messages 1,000/2,000 times and approximately 16.2/64.4 MB of JSON. The incremental path produces identical overlays while serializing only 34/68 KB of fragment JSON and no cumulative assistant messages in that hot path. It also checks escaped characters, split surrogates, revision growth, string/item/overlay limits, structural fallback, and final/snapshot validation. These are serialization-work counters, not network, memory-peak, event-loop-delay, or remote-latency measurements.

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
