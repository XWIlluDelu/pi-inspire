---
scope:
  - server/**
  - shared/**
  - src/**
  - connections/**
  - tests/**
  - docdoki/**
---

# Project quality review

## Objective

Review high-value workflows across the project against [[northstar]], preserving the user's native
Pi settings, sessions and extensions. Fix demonstrated problems with clear repair directions,
retain useful regressions, and ask before changing product semantics or adding capabilities.
Continue until no demonstrated major correctness, reliability or performance problem remains worth
addressing; do not expand into cosmetic changes or classify an isolated flake as a product defect.

## Current state

- Resource preview observations now share the bounded transfer/cancellation boundary with uploads
  (`f1c9169`). Loaded Pi command names, including Unicode and punctuation, remain executable through
  preparation and normalized delivery (`1ff7a1e`). Their new tests pass in the Linux, macOS and
  Windows jobs of [CI run 39532239217](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39532239217).
- That run still fails on older platform assumptions and browser fixtures also present at
  `0740654`. SSH CLI entry detection now follows filesystem aliases. Native RPC presence/rebind
  runs portably, with Linux Herdr ownership as an additional scenario rather than a prerequisite.
- Browser fixtures now route the native `model-cycle` action, recognize addressed unchanged
  snapshot confirmations, and identify an explicit Stop refusal with its failed Host receipt.
  A bare server failure represents uncertainty and cannot stand in for that terminal refusal.
- Local targeted checks pass: 16 SSH/native lifecycle cases, Chromium/Firefox model and layout
  cases, Stop presentation/receipt cases, types, formatting and lint. Local WebKit cannot start
  because a system library is missing; updated CI must supply its cross-engine/platform evidence.
- No Pi runtime source or native cancellation behavior changes belong to these repairs. The
  initial review retained existing bounded/incremental read paths rather than adding another cache
  without evidence of material cost. [[performance]] owns the maintained measurement procedures.

## Current review evidence

- Session switching and recovery: addressed writes, latest-selection ownership, unavailable-workspace
  history, restored-workspace admission and confirmed worker retirement pass the targeted Runtime
  and browser-store checks. No new major defect was demonstrated in these paths.
- Native execution: isolated real-Pi checks confirm receipt reobservation does not execute a shell
  twice, shell Stop uses `abort_bash`, hook dialogs remain answerable, and unexpected worker exit
  retains an unknown outcome without fabricated terminal metadata. These test the existing owned-RPC
  contract; they do not add shell control to native TUI connections.
- Real Herdr/browser continuity passes with a disposable native Pi: prompt and follow-up, page reload,
  isolated Host replacement without page refresh, retained browser draft, stable transcript view,
  resumed input and agent Stop all preserve the original Pi process. The browser fixture now gives
  its Host the same isolated report cache as Pi, matching the native Runtime fixture; a wrong test
  cache previously produced the correct missing-receiver refusal instead of exercising control.
- Transport/history/resources: addressed snapshot barriers, heartbeat/backlog bounds, retained-content
  search/cancellation, incremental catalog summaries, byte ranges and disconnect-time file release
  pass their focused suites. Existing projection measurements and bounded/incremental paths do not
  justify another cache. Public DNS/TLS/proxy latency is not measured by these loopback fixtures.
- CI run 39537796587: macOS passes all phases, including native WebKit; Windows passes Chromium,
  Trash/recovery and launcher checks. Its sole unit failure is the installed SSH runner silently
  skipping `init` through a directory junction. Entry detection now uses Node's `import.meta.main`
  (available before the supported Node 22.19 baseline); both real CLI assertions remain unchanged,
  and the targeted SSH package/lifecycle suites pass locally. Windows Chromium's one successful
  layout retry is a separate flake, not evidence of a major product defect. Linux unit/integration
  and launcher checks pass; its 426-case, single-worker browser run was still progressing when the
  35-minute aggregate job ceiling cancelled it, with no failed-test artifacts. The Linux budget
  now allows 50 minutes for build, core and three browser engines; individual deadlines, assertions
  and scenario coverage are unchanged.
- [CI run 39541401547](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39541401547) confirms
  Windows direct/junction CLI startup, all three packaged releases, complete Linux quality and
  macOS native/browser checks, and Windows Chromium. Its only failure is the unchanged terminal
  history slow-storage fixture exceeding five seconds on Windows (previously passing there).
  A local phase probe attributes about 720 ms to generic deep equality of the 768 KiB Buffer,
  versus about 0.6 ms for flush/read. The fixture now uses native complete-byte equality and advances
  gated chunk-arrival timers synchronously. Real filesystem writes, every byte/batch assertion and
  the five-second deadline remain. Clock simplification alone was not the dominant cost repair.
  The complete history-store suite passes locally; no terminal-runtime change is indicated.
  [CI run 39545599095](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39545599095) confirms
  the corrected Windows history fixture, all Windows/macOS phases, three packaged releases and
  size report. Its sole failure is Linux WebKit's notebook execution-count baseline measurement
  (7.75 px on both attempts); expected 503 fixtures are not additional failures.
- Reader baseline sampling compared viewport coordinates from separate evaluations. A controlled
  8 px preview scroll demonstrates the measurement defect: the old assertion reports 8 px while
  the prompt and source remain aligned relative to their output row. Both samples now use the
  existing row-relative helper, with that scroll retained as a deterministic regression. All five
  reader-baseline cases pass across Chromium, Firefox and WebKit in an isolated matching Playwright
  container, without retries or host-library installation; all gutter/overflow assertions and the
  1 px threshold remain. The original CI's precise 7.75 px movement was not reproduced, so its
  dynamic cause is not claimed. No product CSS or component change is indicated by these results.

## Next actions

- [ ] Confirm the CI attached to the row-relative reader-baseline repair. The parent observer
  follows GitHub; no local watch remains. Investigate actual failures without weakening assertions
  or skipping portable scenarios.
- [x] Complete the targeted whole-product review with no remaining evidence-supported major issue.
  Stop expanding scope; public network latency and arbitrary third-party extensions remain outside
  these controlled local/remote-chain checks.
- [x] Verify clear repairs as semantic changes, preserving unrelated work and shared history.
  The final correction changes only tests/documentation, so it needs no source-install rebuild,
  prepare-restart repetition or production Host restart.

## Decisions

- Pi owns model-cycle order and extension effects. The shortcut fixture grants both directions to
  test key delivery; this does not claim that the installed Pi RPC supports reverse cycling.
- Snapshot synchronization can confirm an unchanged digest without repeating snapshot data. A
  fixture needing the selected subscription must check its addressed owner rather than require data.
- Independent RPC presence is portable; Linux process-group identity is a Herdr-specific boundary.

## Handoff

Read [[northstar]], [[spec_abstract]] and the relevant contracts before continuing from Next actions.
Use the current tree and CI results, not the old failed run, as the next review baseline. Do not
repeat whole suites merely to increase coverage counts, or turn a test fixture into a second runtime.
