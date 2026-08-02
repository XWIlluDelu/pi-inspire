---
scope:
  - package.json
  - package-lock.json
  - server/runtime.ts
  - server/session-catalog.ts
  - shared/resource-references.ts
  - src/events.ts
  - src/store.ts
  - src/resources.ts
  - src/components/Nav.tsx
  - src/components/ResourcesPane.tsx
  - tests/**
---

# Evidence-gated maintenance

## Objective

Change performance, optional resilience, proactive mention checking, or dependency internals only when current evidence identifies a user-visible problem, while always keeping inspire compatible with and exactly pinned to the latest released Pi.

## Current state

- Working: resource extraction on visible token deltas, whole-store subscriptions, and repeated settlement refreshes are concrete suspects but have no measured user-visible regression.
- Working: the on-demand file resolver tells the truth after first click, and existing generation/snapshot guards have no reproduced late-event or throughput failure; proactive mention batches and delta coalescing therefore remain unselected.
- Working: Pi 0.83.0 is the latest terminal and npm boundary, is pinned exactly, and passes the current compatibility suite/build.
- Tracked upstream: Pi's shrinkwrapped tree still contains an affected nested `brace-expansion`. The advisory remains real and unresolved, but it does not block latest-Pi compatibility and must not cause a downgrade or an unsupported root override; see [[dependency-boundaries]].

## Next actions

- [x] Freeze a representative long-session scenario with Files visible, active streaming, several background settlements, and navigation/context chrome. Capture React commit counts and durations, browser long tasks/input delay, host catalog and projection timings, and request/frame counts.
- [x] Activate only the suspect to which the trace attributes repeatable user-visible cost. Preserve explicit refresh immediacy and compare the same frozen scenario before and after; a microbenchmark or bundle warning alone is not a trigger.
- [x] If resource extraction is measured, update from settled message/tool boundaries and rebuild authoritatively on snapshot, replacement, or compaction; do not parse token deltas.
- [x] If subscriptions are measured, add selector/equality-aware reads over the one existing store rather than splitting state into parallel authorities.
- [x] If settlement refresh is measured, coalesce only automatic background refreshes and keep the explicit user refresh immediate.
- [x] If stale-mention first-click surprise becomes a reproduced irritation, batch-check only the visible bounded projection through the existing project index, retain on-demand resolution as authority, and clear stale marks when a later resolution succeeds.
- [x] If a post-Projection event-loss or throughput trace reproduces a problem, reuse projection revisions and current generation guards for late-event rejection; coalesce frame deltas only when that exact bottleneck is measured.
- [x] On every dependency update, require `npm view @earendil-works/pi-coding-agent version` to equal the exact `package.json` pin and lockfile root resolution. Never downgrade Pi to improve an audit report.
- [x] For each new Pi release, inspect release notes, RPC/SDK contracts, engines, and nested versions in a clean copy, then run focused real-RPC state, bounded entry cursor, tree, model, command, stats, session replacement, compaction, extension UI, session-directory, and read-only existing-session compatibility checks without sending a paid model prompt.
- [x] Run `npm audit --omit=dev` and record remaining Pi-owned findings. Retire a finding only when the installed supported tree no longer contains it; do not use a root override to manufacture a clean audit.
- [x] After any activated change, prove interaction/output equivalence, run its focused tests, `npm run check`, and `npm run build`.

## Acceptance

A dependency maintenance update is accepted only when:

- [x] `npm view @earendil-works/pi-coding-agent version` exactly matches `dependencies["@earendil-works/pi-coding-agent"]` and the lockfile root resolution.
- [x] Latest-Pi focused compatibility checks, `npm run check`, and `npm run build` pass.
- [x] `npm audit --omit=dev` is recorded truthfully, with unresolved Pi-owned advisories contained and upstream-tracked rather than claimed fixed.
- [x] No downgrade or unsupported nested override was used to change the audit result.

## Decisions

- Presence in a hot-looking path is not evidence of a performance defect. No speculative cache, retry, coalescer, mention batch, or store split is added.
- Latest released Pi is the required compatibility boundary. Audit status and latest-version compatibility are independent gates: an inherited Pi advisory stays visible but cannot force a downgrade.
- Dependency changes occur only at the supported package boundary; nested overrides remain rejected.
- Utility consolidation occurs inside a selected behavior change only when the uses share meaning and ownership; there is no standalone deduplication refactor.

## Outcome

The frozen evaluator completed two isolated batches of 21 accepted browser samples and 21 host repetitions over an 11,830,406-byte Pi session whose active projection remained bounded to 100 messages/39,324 bytes. Each batch accepted 21 samples within 22 attempts, discarded one sustained event-loop-load outlier, and independently returned `no-performance-change`; the final recorded checks and build ran afterward, never concurrently. Continuous frame-gap and event-loop controls reject and retry sustained-load contamination within a 28-attempt budget, and an insufficient uncontaminated budget returns `invalid-benchmark` rather than no change. Activation requires both threshold-reaching p95 and at least three individual crossings (10% rounded up, with an absolute minimum of three). Its measured window includes a concrete Changes row plus an observed refresh/loading cycle, changed rendered status and selected-diff revisions, settled controls, and retained selection; four Branches rows plus current/edit/fork/refresh controls and a completed edit-from-here prefill, then referenced Files with live text/tool/queue streaming and four background completions derived from rendered authoritative session status. No activation threshold crossed, so no performance suspect was implemented. The durable evaluator and baseline live in `tests/benchmarks/evidence-gated-maintenance.ts` and [[performance-evidence]].

Dependency maintenance completed at the unchanged supported boundary: registry latest, exact manifest pin, lockfile root, installed package, and project terminal Pi all equal 0.83.0. The installed-Pi compatibility test adds no-paid-model coverage for read-only preview, state, bounded cursor, tree, model, command, stats, every RPC extension UI category, offline custom compaction, session directory, replacement, switch, and fork. Pi's current RPC/SDK/export/engine/release/nested boundaries are recorded in [[dependency-boundaries]] and [[pi-integration]].

## Verified

- Evaluator: two consecutive isolated `INSPIRE_BENCHMARK_ISOLATED=1 npx tsx tests/benchmarks/evidence-gated-maintenance.ts` batches independently returned `no-performance-change` in 47/46 seconds, each accepting 21 samples within 22 attempts and observing zero crossings for every activation witness. Each discarded one attempt whose event-loop-delay p95 crossed the 25 ms contamination bound (26.00/25.90 ms), directly exercising bounded retry. Batch A/B Changes p95 was 173.00/176.80 ms and Branches p95 was 117.40/113.20 ms against the 200 ms bound; aggregate React p95 navigation 9.50/9.70 ms, transcript 2.40/2.50 ms, composer 0.90/0.90 ms, resources 0.70/0.70 ms; no long tasks; aggregate input-delay p95 1.00/0.80 ms; scroll-delay p95 14.70/14.10 ms; projection/catalog/Git-status p95 16.65/11.78/11.60 ms and 17.39/11.78/12.93 ms. Accepted frame/event-loop control p95 was 16.80/15.10 ms and 16.80/16.00 ms against 25 ms contamination bounds.
- Accounting: every measured run has exactly 52 WebSocket frames/71,218 bytes whose complete ordered `{type, sessionId, outcome}` sequence matches the event schedule, plus exactly 1 branch-navigate, 2 branch-tree, 2 diff, 3 Git-status, 1 prompt, 4 session-list, and 1 snapshot request. Failure probes prove malformed JSON, missing typed address, missing/extra frame, order/type, session-address, and outcome differences are rejected.
- Production build: `npm run build && npx tsx tests/benchmarks/verify-production-bundle.ts` scanned all four generated text artifacts, including any source maps (none emitted), found zero benchmark profiler/callback/global/mode/module symbols, confirmed four direct-element fallbacks, and reported zero production wrapper fibers.
- Installed Pi: registry/manifest/lock root/lock node/installed/terminal are all 0.83.0; Node 26.5.0 satisfies Pi's `>=22.19.0` engine.
- Compatibility: `npx vitest run tests/server/pi-rpc.test.ts tests/server/pi-compat.integration.test.ts tests/server/pi-branch-bridge.integration.test.ts tests/server/runtime.test.ts tests/server/runtime-projection.test.ts tests/server/runtime-branching.test.ts tests/server/session-projection.test.ts tests/server/session-catalog.test.ts tests/server/session-preview.test.ts tests/server/session-tree.test.ts --reporter=dot` passed.
- Frozen-stage validation: `npm run check` passed; an independent full Vitest run passed the then-current 431/431 tests; `npm run build` passed with only the non-triggering existing Vite chunk warning.
- Subsequent final backlog validation passed the expanded 491-test suite in 46 test files, the production build and bundle-absence witness, and the real Chromium smoke without activating a performance change.
- Hygiene: conventional `/test-results/` output is ignored, prior scratch results were removed, and no evaluator JSON, screenshot, Chrome profile, or temporary session remains in the worktree.
- Audit: `npm audit --omit=dev` exits nonzero for one unresolved high-severity Pi-owned `brace-expansion` 5.0.7 finding (`GHSA-mh99-v99m-4gvg`). No downgrade, audit fix, or root override was applied.

## Explicitly unactivated suspects

- Settled-boundary resource extraction: measured aggregate resources commit p95 0.70/0.70 ms; no attributable interaction cost.
- Selector/equality store reads: navigation commit count is diagnostic, but 9.50/9.70 ms aggregate p95 with no long tasks and 1.00/0.80 ms aggregate input delay does not prove user-visible cost.
- Automatic-background-only refresh coalescing: four settlements produced four refresh requests, but no attributable threshold crossing.
- Bounded visible mention checks: current bounded visible projection produced no reproduced first-click or trace cost.
- Revision/generation changes: no stale result, event-loss, or output-equivalence failure reproduced.

## Handoff

Stop performance work when profiling does not reproduce a user-visible cost. For Pi maintenance, keep the latest exact pin, record compatibility evidence and any surviving upstream advisory, and revisit the advisory when a newer Pi release changes its supported shrinkwrapped tree.
