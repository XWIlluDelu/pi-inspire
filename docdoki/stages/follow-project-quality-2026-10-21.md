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
  and scenario coverage are unchanged. The revised entry path still needs native Windows CI
  confirmation, and the complete Linux browser tail must finish under the corrected aggregate.

## Next actions

- [ ] Check the new CI run for these repairs. Distinguish actual failures, environment startup
  failures and flaky attempts; do not weaken assertions or skip whole portable scenarios.
- [ ] Investigate further only from concrete, high-value workflow or cost evidence. Keep each
  review round's confirmed findings, exclusions and next direction concise.
- [ ] Implement and verify clear fixes as semantic commits; preserve unrelated work and shared
  history. Keep project design choices explicit instead of inferring them from missing APIs.

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
