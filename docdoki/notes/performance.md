# Performance and measurement

## Performance evidence

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

## Rich rendering reuse

### Why reuse generated leaves

The previous `RichText` ran rehype-katex over the entire message on every text
update, expanded every formula into a large HAST/React subtree, and highlighted
all code again. Whole-document Markdown parsing is needed for correct late
reference definitions, footnotes, and changing open block structure; repeating
KaTeX and highlighting for unchanged expressions is not.

The renderer now memoizes math and code leaves after the same Markdown
source-safety and sanitize passes. Math retains rehype-katex, its error handling,
`trust:false`, and the same HAST-to-React converter used by react-markdown. There
is no HTML-string injection for math. Primitive expression/mode and source/language
props let React reuse generated subtrees even inside a changing paragraph.
Highlighting also has a local `useMemo` so copy feedback does not repeat it.

This avoids an incremental-parser state machine, ambiguous source splitting,
global reference invalidation rules, and caches of historical message versions.
State is proportional to currently mounted content. Remounts and structural
reclassification may repeat work; they cannot return stale cached output.

The code-block correction reads sanitized `pre > code` structure instead of
inferring blockness from `language-*`. Unlabeled/indented code keeps whitespace
and copy/terminal controls, including paths that should not become inline file
buttons. The one newline appended by mdast-to-hast is removed; source blank
lines before it remain.

### Checks

```sh
npx vitest run tests/web/rich-text.test.tsx tests/web/rich-text-streaming.test.tsx tests/web/document-preview.test.tsx --configLoader runner --no-cache --maxWorkers=2
npx tsc -p tsconfig.web.json --noEmit
npx vite build --configLoader runner --outDir dist
```

The focused suite passes 65 tests, including existing defensive math, selection
copy, and document-resource behavior. New checks cover unlabeled/indented and
incomplete fences, source whitespace/copy, inline references, streamed-vs-fresh
DOM equality at small delimiter-crossing chunks, late/duplicate references and
footnotes, nested loose lists, tables, setext headings, multiline math, and
sanitization. Math subtree comparisons retain the prior rehype-katex output.
Work counters show zero KaTeX/highlighter calls for 20 trailing-text updates over
three stable formulas and two code blocks; changing one expression and one code
block invokes each renderer once. Removing/remounting content recomputes rather
than retaining an accumulated cache. Production web build and web typecheck pass.

### Local production-browser measurement

```sh
mkdir -p output
node scripts/benchmark-rich-text.mjs 3 --baseline=cfbe21114e23 > output/rich-text-before.json
node scripts/benchmark-rich-text.mjs 3 > output/rich-text-after.json
```

The baseline option compiles that Git revision of `RichText.tsx` against current
dependencies and the same benchmark fixture, without editing/checking out files.
The script builds the actual component with production React and project CSS,
serves it on an ephemeral loopback port, and uses headless Chromium. No Host,
transport, fake app runtime, or deployment participates. Each case mounts a
completed prefix, awaits fonts, and appends a changing text tail over 12 updates:
three warmups, nine measured samples, with animation-frame gaps. It measures
synchronous React render+commit and separately the time through forced layout;
it does not claim to measure paint or end-to-end token delivery. Each case also
asserts that the streamed DOM equals a fresh complete-source render.

Confirmation run: React 19.2.7, Chromium 151.0.7922.34, three rounds. Values are
median-of-round-medians in milliseconds; brackets give the three round medians'
range. Mixed content repeats tables, inline/display math, highlighted TypeScript,
links, lists, and prose. Sizes are actual ASCII source bytes.

| Source | Before render+commit | After render+commit | Before / after through layout |
| --- | ---: | ---: | ---: |
| Mixed 16,074 | 31.0 [29.4–32.3] | 10.9 [9.8–13.1] | 32.3 / 11.1 |
| Mixed 32,148 | 63.9 [60.9–64.9] | 19.7 [19.0–23.1] | 65.8 / 20.1 |
| Mixed 64,296 | 130.2 [126.2–130.6] | 42.2 [40.5–43.2] | 134.0 / 43.0 |
| Plain 64,262 | 10.4 [10.4–10.4] | 10.5 [10.4–10.7] | 10.5 / 10.6 |

Mixed-content update cost fell about 65–69%; plain-text cost was effectively
unchanged. An earlier independent three-round build/run also showed the same
material reduction (mixed 64 KB: 124.4 → 48.1 ms). These are local measurements
on a potentially shared CPU, not universal latency guarantees or a comparison
to a differently shaped workload.

### Remaining cost

The full-document Markdown/GFM/math parse, source-safety, sanitize pass, and
ordinary Markdown React reconciliation still scale with current source length.
Large plain text, first mounts, changing large fences/formulas, and structural
changes do not get a constant-time update guarantee. The 64 KB mixed case still
exceeds one 60 Hz frame. This optimization removes verified redundant expensive
rendering without trading away correctness or introducing a competing parser.

## Session-scale evidence

Persisted entries, active-branch projections and child RPC frames have different size distributions. Bound them independently.

These are observations, not limits to encode. Histories keep growing, and one tool result can make a future entry larger. The durable boundary is structural:

- Initial projection reads the session file incrementally and bounds each persisted line independently from total history size.
- Browser transcript pages are bounded by serialized bytes as well as item count; virtualization bounds mounted DOM, not transfer or retention.
- Pi RPC `get_entries { since }` is suitable only after a trusted baseline cursor exists, because an initial response still aggregates the whole append-order history into one JSONL frame.
- The malformed or unterminated child-output guard stays independent and fatal; a legitimate long history must avoid the aggregate `get_messages` path rather than receive a larger exception.

The measurement streamed each file to obtain complete-line sizes, then used `SessionManager.open`, `getEntries`, `getLeafId`, and `buildSessionContext` to serialize the active branch. The current code boundaries are `server/pi-rpc.ts`, `server/session-preview.ts`, `server/runtime.ts`, `shared/contracts.ts`, and `server/app.ts`.
