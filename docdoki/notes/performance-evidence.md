---
purpose: Scoped performance measurements and reproduction points; historical experiments are not current acceptance gates.
---

# Performance evidence

## Release-round check — 2026-10-11

Linux, Node 26.10.0, production Chromium build; local mock Host and installed-Pi fixtures.

- **Live tool output:** a 325,013-character cumulative text fixture exceeded the generic head cap.
  Moving tail selection ahead of that cap preserved the latest marker. Uncompressed event JSON
  decreased from 269,420 to 5,780 bytes; event and reconnect snapshot carry the same bounded preview.
  Character/line-bound cases in `runtime-projection.test.ts` retain this regression.
- **Session switching:** three browser switches issued six Git status requests before the topbar
  subscription repair and three afterward. The repair removes the cancel/restart pair instead of
  adding a cache. The repository/non-repository transition case is in `git-store.test.ts`.
- **Rich text:** the maintained production benchmark's 256,338-byte mixed document had median
  immediate commit 0.4 ms, layout 2.5 ms, full rich-format availability 228.9 ms and frame gap 26.5 ms.
  Output equivalence passed. The formatting work remains asynchronous; these observations did not
  justify an additional renderer redesign.

[[challenge-release-round-quality-2026-10-11]] records the associated review and verification.

## Draft and History work (2026-10-06)

Linux / Node 26.10.0, pre-optimization sources preserved at `d52f2f2`. Initial draft hydration plus 200 edits changed
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
[[maintainability-review]]. No timing thresholds were added to tests.

## Pi 1.0 source and catalog profiles (2026-10-05)

Local production Chromium at 1440×900 reproduced synchronous source-highlighting cost. A
1,500-line / 193,500-character TypeScript source generated 21,000 spans; repeated opens produced
highlighting/layout task pairs of 66+195 ms and 59+191 ms. With the per-leaf highlight budget reduced
to 64 Ki characters, neither open produced a task above 50 ms. The actual 105,793-character
`src/store.ts` changed from a 105 ms task to none above 50 ms; a 64,500-character source still
highlighted. Larger leaves retain plain text and copying. Source: `src/syntax-highlighting.ts`;
outcome: [[challenge-pi-1-quality-2026-10-05]].

The desktop/390px native fixture held 1,537 catalog / 1,080 available models and mounted at most 12
picker/grid rows while passing distant navigation, search and overflow checks. This demonstrates
bounded mounting/interaction, not model-query latency.

A 16,795,320-byte Host projection fixture took median 7.248 ms forced versus 0.022 ms
version-checked. A separate 20,000-entry / approximately 41 MiB History fixture returned 100-node /
approximately 77 KiB pages: outline work took 6.7–13.8 ms and full-text search 20.3–25.7 ms over five
runs. These are local synthetic projection measurements, not remote end-to-end timings. Boundaries:
[[projection-reconciliation-ownership]], [[session-scale]]. No further optimization followed.

## Settings shell continuity (2026-09-06)

A production Chromium probe found two Settings dialog nodes and two starts of both entrance
animations on first open: Suspense fallback and ready content each owned an animated shell.
Subsequent opens reused the module. The eager `SettingsDialog` now owns overlay, header and focus;
only its content is deferred.

A fresh context with service workers blocked and the module delayed 600 ms checked 1280×720/light
and 390×844/dark: one shell, one start per animation, and opacity 1 throughout readiness. Injected
module-evaluation failure preserved that dialog and Reload; Escape restored its opener.
`tests/web/settings-loading.test.tsx` covers loading dismissal, stable shell/control identities and
focus continuity. This is transition correctness, not startup-latency evidence.

## Streaming work counters

`tests/server/runtime-stream-budget.test.ts` compares the real reducer/overlay with incremental
accounting disabled and enabled. For 1,000/2,000 alternating 32-character text/thinking fragments,
the old path serialized cumulative messages 1,000/2,000 times and approximately 16.2/64.4 MB of JSON.
The incremental path produces identical overlays using 34/68 KB of fragment JSON and no cumulative
message serialization in that hot path. Escapes, split surrogates, revision growth, budgets,
structural fallback and final/snapshot validation remain covered. These are work counters, not
network, peak-memory or latency measurements. Tool-argument wire evidence: [[streaming-tool-arguments]].

## Retired long-session evaluator

Retired 2026-09-08: the opt-in evaluator had drifted into another fake protocol implementation,
with five TypeScript diagnostics and eleven missing runtime methods. Its exact HTTP/frame ledger
predated interest-scoped/batched delivery, and its source-text verifier rejected ordinary formatted
renderer branches. It was not a CI regression gate. Preserve the measurements, not a second runtime.

The historical fixture held 11,830,406 bytes of Pi JSONL, a large abandoned branch and a bounded
100-message active projection. Each batch used 21 accepted fresh-browser samples at 1440×900 plus
21 Host repetitions. It exercised Changes refresh/diff, History inspection/edit, referenced Files,
search, Pending, 36 text deltas, a tool lifecycle and four rendered background completions. React
commits, Long Task/Event Timing, scroll delay, request/frame accounting and real projection/catalog/
Git timings were observed. Frame-gap and event-loop p95 above 25 ms invalidated an attempt; failing
to collect 21 accepted samples within 28 attempts yielded `invalid-benchmark`, not no change.

The experiment required threshold-reaching p95 and at least three individual crossings. Thresholds
were 50 ms for long-task/input/scroll delay, 200 ms for the two-action Changes/History flow, 16.7 ms
for a React surface, and 150/150/100 ms for Host projection/catalog/Git. These were experiment-specific
gates, not permanent requirements. All valid runs below returned `no-performance-change`.

| Run and application/evaluator commit | Environment | Accepted / attempts | Changes / History p95 | Host projection / catalog / Git p95 |
| --- | --- | --- | --- | --- |
| 2026-08-01 `b4d2b4b26bf2dacafda21c123dc4c8a842476bf6` | Node 26.5.0, npm 11.17.0, Chromium 145.0.7632.6, Pi 0.83.0 | Two batches, each 21/22 | 173.0 / 117.4 ms; 176.8 / 113.2 ms | 16.65 / 11.78 / 11.60 ms; 17.39 / 11.78 / 12.93 ms |
| 2026-08-07 `4002fa6f23400640394601234922e2fcac057c74` | Node 26.5.0, Chromium 145.0.7632.6, Pi 0.84.1 | 21/26 | 175.5 / 114.9 ms | 17.95 / 13.22 / 10.86 ms |
| 2026-08-08 `c6acf45071fbcc589867a2e4e96d00329e8a795e` | Node 26.5.0; repaired evaluator and Dynamic dwell policy | 21/22 | 179.9 / 115.7 ms | 16.41 / 12.22 / 12.42 ms |
| 2026-08-24 `11d4bc2ad1487512060a7997d14c8acd9818effb` | Node 26.5.0, Chrome for Testing 152.0.7977.8 | 21/28 | 184.2 / 116.9 ms | 17.64 / 13.06 / 12.35 ms |

No valid run observed a long task or repeatable activation crossing. An earlier August 24 run
contaminated by concurrent CPU work exhausted its budget and is not performance evidence.
Resource extraction, broad subscriptions, automatic refresh coalescing and proactive mention checks
were unactivated hypotheses at those baselines, not present-day diagnoses.

Reproduce only with the corresponding application **and** evaluator in an isolated checkout:

```sh
git worktree add --detach /tmp/inspire-performance-history 11d4bc2ad1487512060a7997d14c8acd9818effb
cd /tmp/inspire-performance-history
npm ci
INSPIRE_BENCHMARK_ISOLATED=1 npx tsx tests/benchmarks/evidence-gated-maintenance.ts
```

Use recorded runtime/browser versions, isolated free ports (defaults 14587/15173; overrides
`INSPIRE_BENCHMARK_HOST_PORT`/`INSPIRE_BENCHMARK_WEB_PORT`) and no concurrent CPU-heavy checks.
The evaluator discovers Chromium, creates/removes temporary state and prints results to stdout.
The historical commit also contains `tests/benchmarks/verify-production-bundle.ts`, which checks
benchmark symbols/direct-element production branches after a build. Neither tool is in the current
tree; obsolete exact frame counts and source-string checks are not current contracts.

Future performance work needs a current representative scenario and before/after comparison with
equivalent output and operation semantics. Maintained stream-budget tests, browser network ledgers
and `transport-performance` counters remain available. Removing old instrumentation claims no speedup.

## Package size versus font transfer

`npm run size:report` prepares and validates release artifacts before packing. On 2026-08-14 it
reported 29,781,248 tarball bytes, 37,158,962 unpacked bytes, 34,116,728 packaged font bytes and
729,564 bytes across 21 filename-derived `coldStartFontCandidates`. That last field is a package
heuristic, not transfer.

The mock workbench's cache-disabled CDP network ledger, observed after fonts and network settled,
measured 297,018 aggregate encoded font bytes for both desktop and 390px scenarios. Browser/content/
Unicode-range selection can change it; it is neither installation size nor a release budget. Set a
budget only from representative current scenarios.
