---
purpose: Frozen long-session evaluator, activation thresholds, and current evidence for evidence-gated maintenance.
---

# Performance evidence

## Reproducible evaluator

Run from the repository root with its isolated loopback ports free (defaults: host 14587, web 15173), with no build, check, test, or other intentional CPU workload running concurrently. Override them with `INSPIRE_BENCHMARK_HOST_PORT` and `INSPIRE_BENCHMARK_WEB_PORT` when needed:

```sh
INSPIRE_BENCHMARK_ISOLATED=1 npx tsx tests/benchmarks/evidence-gated-maintenance.ts
```

The environment flag is an explicit assertion that this isolation precondition has been met; without it the evaluator refuses to start. Run `npm run check` and `npm run build` only after all benchmark batches finish.

The executable evaluator creates and removes its own temporary Pi session, workspace, preferences, Chrome profile, Vite proxy configuration, and host, then writes the complete machine-readable result to stdout without retaining a profiling artifact. It discovers `CHROME_PATH`, system Chromium/Chrome, or the newest Playwright Chromium cache entry instead of hard-coding one browser release; teardown terminates Chrome before removing its profile. The browser viewport is fixed at 1440×900 so desktop-surface performance is not reinterpreted by responsive drawer behavior. The fixture persists 11,830,406 bytes of valid Pi JSONL, with a large abandoned branch and a bounded 100-message active projection. It keeps Files, Changes, and Branches available, session and transcript search populated, pending steer/follow-up queues visible, and branch navigation controls present while delivering 36 text deltas, a tool lifecycle, and four background settlements.

Twenty-one accepted fresh browser samples characterize frontend noise; 21 fresh opens or forced reads characterize each host operation. With 21 samples, nearest-rank p95 is the second-highest sample rather than the maximum. The observation window starts before Changes: every iteration selects the concrete changed row, then observes the explicit refresh button/loading cycle, a changed rendered Git-status revision, a changed selected-diff revision, the settled controls, and retained selection before stopping that interaction timer. It then opens four real branch rows, proves current/edit/fork/refresh control state, executes edit-from-here and observes the composer prefill, returns to referenced Files, and runs text/tool streaming with pending queues and four background settlements. Settlement success is derived from the four rendered Completed session rows after the authoritative snapshot resync, not from fixture intent. The evaluator records these end-to-end Changes/Branches durations, React Profiler commits and actual durations by navigation/transcript/composer/resources surface, Long Task and Event Timing observations, wheel-to-animation-frame delay, exact CDP request/WebSocket accounting, and real `SessionProjection`, `SessionCatalog`, and `GitInspectionService` timings.

A continuous requestAnimationFrame-gap control and 25 ms event-loop-delay control run throughout every measured browser attempt. An attempt is accepted only with at least 30 frame and 20 event-loop observations and with both control p95 values <=25 ms. A contaminated attempt is recorded, discarded, and retried; the evaluator must obtain 21 accepted samples within 28 total attempts. If it cannot, it emits `decision: invalid-benchmark`, exits nonzero, and cannot report no change.

The frozen activation thresholds are:

- browser long task p95 >= 50 ms;
- input event delay p95 >= 50 ms;
- wheel-to-animation-frame delay p95 >= 50 ms;
- either two-action Changes or History flow p95 >= 200 ms (two 100 ms response budgets);
- any React surface commit p95 >= 16.7 ms;
- host projection or catalog p95 >= 150 ms;
- host Git status p95 >= 100 ms.

Counts and aggregate React work remain diagnostic. Every activation uses independent-sample witnesses: p95 must reach its threshold **and** at least `max(3, ceil(samples * 0.10))` samples must individually cross it. At 21 samples this requires three crossings, so neither one spike nor the two samples that determine nearest-rank p95 can activate work alone. React uses each iteration's surface p95 as its independent value. A Vite chunk-size warning or an isolated microbenchmark never activates maintenance by itself.

## 2026-08-08 project-hardening validation

The repaired evaluator ran against the completed hardening change set and final Dynamic dwell policy on isolated ports. It accepted 21 browser samples within 22 attempts and rejected one attempt whose event-loop-delay p95 reached 31.70 ms against the 25 ms control bound, so the final decision used only uncontaminated samples. Exact accounting observed 52 typed WebSocket frames and one `/api/resources/list` request per accepted iteration in addition to the established branch, Git, prompt, session-list, and snapshot contract. The settled-tool witness accepts either the ordinary tool card or Dynamic mode's compact button with the same accessible `read: finished — analysis.ts` identity, instead of depending on an internal card-name node remaining mounted across its minimum-residency transition. No activation witness crossed its threshold three times, and the evaluator returned `no-performance-change` with zero activated suspects.

- Browser p95: Changes 179.90 ms and History 115.70 ms against 200 ms; input delay 1.00 ms and scroll delay 12.50 ms against 50 ms; no long tasks.
- React per-iteration surface p95: navigation 11.70 ms, transcript 2.70 ms, composer 0.90 ms, Files 1.00 ms against 16.7 ms.
- Host p95 over the 11,830,406-byte fixture: projection 16.41 ms, catalog 12.22 ms, Git status 12.42 ms against 150/150/100 ms.
- The repaired request contract attributes `/api/resources/list: 1` to the one bounded Files page loaded after returning from History; an extra, missing, or misordered request remains an invalid sample rather than a performance result.

The accepted conclusion is to keep the bounded resource index/pagination and completion-scheduled Git polling fixes, but add no further speculative cache, subscription split, or background coalescer.

## 2026-08-07 current evidence

Environment: Node 26.5.0, Chromium 145.0.7632.6, Pi 0.84.1. One isolated full batch accepted 21 samples in 26 attempts, discarded five frame-gap/event-loop-contaminated attempts at 33.20–33.30 ms frame-gap p95 or 25.10–30.90 ms event-loop p95 against the 25 ms control bound, and returned `no-performance-change` with zero activated suspects. Host p95 was 17.95 ms for projection, 13.22 ms for catalog, and 10.86 ms for Git status. Browser p95 was 11.20 ms for navigation commits, 2.40 ms for transcript commits, 0.50 ms for composer commits, 0.70 ms for resources commits, 0.80 ms for input delay, and 11.90 ms for scroll delay; no long task was observed. The Changes and Branches interactions measured 175.50 ms and 114.90 ms p95 respectively, both below their 200 ms gate. The active projection serialized to 43,174 bytes. The evaluator therefore authorizes no speculative application performance change.

This run also witnesses the maintenance fixes themselves: the benchmark uses isolated ports without editing `vite.config.ts`, targets its own host rather than the normal 4587 instance, selects the newest available Playwright Chromium instead of `chromium-1232`, holds a deterministic desktop viewport, and terminates Chrome before profile cleanup.

## 2026-08-01 baseline

Environment: Node 26.5.0, npm 11.17.0, Chromium 145.0.7632.6, Pi 0.83.0. Two isolated full batches ran consecutively with no concurrent check or build; the final recorded checks and build ran afterward. The batches took 47 and 46 seconds, each accepted 21 samples within 22 attempts, discarded one sustained-load-contaminated attempt, and independently returned `no-performance-change` with zero activated suspects. Batch A rejected event-loop-delay p95 26.00 ms and batch B rejected 25.90 ms against the 25 ms control bound, directly exercising bounded retry.

| Observation (p95 ms unless noted) | batch A | batch B |
| --- | ---: | ---: |
| projection open | 16.65 | 17.39 |
| catalog forced list | 11.78 | 11.78 |
| real Git status | 11.60 | 12.93 |
| Changes two-action flow | 173.00 | 176.80 |
| History two-action flow | 117.40 | 113.20 |
| Files plus fixed stream | 1,014.40 | 1,012.80 |
| navigation commit (aggregate) | 9.50 | 9.70 |
| transcript commit (aggregate) | 2.40 | 2.50 |
| composer commit (aggregate) | 0.90 | 0.90 |
| resources commit (aggregate) | 0.70 | 0.70 |
| browser long task | 0.00 | 0.00 |
| input delay (aggregate) | 1.00 | 0.80 |
| scroll delay (aggregate) | 14.70 | 14.10 |
| frame-gap control | 16.80 | 16.80 |
| event-loop-delay control | 15.10 | 16.00 |

All activation witnesses had 21 independent values, required three crossings, and observed zero. In particular, per-sample Changes p95 was 173.00/176.80 ms with maxima 175.40/177.10 ms, and History p95 was 117.40/113.20 ms with maxima 117.60/120.90 ms. Per-sample React witness p95 values remained at most 10.00/10.10 ms. Thus both the percentile gate and repeatability gate independently remain below activation.

The counters reset at the observation boundary after bootstrap/search/initial status settles. Every iteration then receives exactly 52 WebSocket frames/71,218 bytes: 5 prompt-start frames + 36 text deltas + 1 tool end + 8 background lifecycle frames + 2 selected-session settlement frames. Each payload must parse as JSON and the complete ordered sequence must exactly match the expected `{type, sessionId, outcome}` witnesses: roles for message boundaries, running/completed status for agent boundaries, queue counts, tool name/result, and `text_delta` updates. Startup failure probes prove rejection of malformed JSON, a missing typed address, missing/extra frames, wrong order/type, wrong session address, and wrong outcome. HTTP is also exact per iteration: 1 branch navigate, 2 branch trees (initial plus post-navigation), 2 diffs (selection plus explicit-status selected-diff reload), 3 Git statuses (Changes entry, explicit refresh, settled tool refresh), 1 prompt, 4 session-list refreshes (one per rendered background completion), and 1 selected-session snapshot resync. Any missing, extra, reordered, mistyped, differently addressed, or wrong-outcome request/frame fails the evaluator.

**Decision:** no activation threshold crossed, so no speculative performance implementation was made.

Explicitly unactivated suspects:

- resource extraction at settled boundaries: the current bounded visible-message pass had 0.70 ms aggregate React p95 and no input trace cost;
- broad store subscriptions/selectors: repeated navigation commits were visible in the diagnostic count, but 9.50/9.70 ms aggregate p95, no long tasks, and 1.00/0.80 ms aggregate input-delay p95 do not establish user-visible cost;
- automatic background refresh coalescing: four settlements produced four refresh requests, but no attributable user-visible latency crossed a threshold;
- visible mention checks: the bounded 100-message resource surface remained below threshold;
- revision/generation guard changes: no stale-result or output-equivalence failure occurred in the frozen scenario.

These remain hypotheses, not authorized optimization work. Re-run the same evaluator before activating one coherent change, then require the same assertions and output/frame/request accounting to remain equivalent after it.

## Production instrumentation witness

The evaluator uses compile-time `import.meta.env.MODE` branches directly at each App call site. A normal production build selects the direct Nav, Transcript, Composer, and Resources elements; it does not render a benchmark component or Fragment fiber. After `npm run build`, run:

```sh
npx tsx tests/benchmarks/verify-production-bundle.ts
```

The witness scans every production HTML/JS/CSS/source-map artifact and fails on the benchmark component name, callback, global sink, mode constant/string, or module identity. The 2026-08-01 production build scanned four artifacts (no source maps were emitted), found zero benchmark symbols, confirmed all four direct-element production fallbacks, and reported zero wrapper fibers in those production branches.
