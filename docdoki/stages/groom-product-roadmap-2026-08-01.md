---
scope:
  - docdoki/stages/**
---

# Product roadmap

## Objective

Keep one ordered selection surface for product work that is not yet true of the implementation. Focused stages own their acceptance criteria; this stage owns only priority and selection.

## Current state

- Working: the selected local product round is implemented and independently reviewed: session continuity, Git inspection, conversation inspection, daily-use accelerators, session branching, session-list pagination, and evidence-gated maintenance.
- Deferred by the human on 2026-08-01: [[groom-personal-remote-relay-2026-08-01]]. Remote access is not part of the current implementation goal and no incomplete relay code or cryptographic scaffold remains.

## Completed order

- [x] Priority 0 [[groom-session-continuity-correctness-2026-08-01]].
- [x] [[groom-git-inspection-2026-08-01]] and [[groom-conversation-inspection-2026-08-01]].
- [x] [[groom-daily-use-accelerators-2026-08-01]].
- [x] [[groom-session-branching-2026-08-01]].
- [x] [[groom-session-list-pagination-2026-08-01]].
- [x] [[groom-evidence-gated-maintenance-2026-08-01]] after its compatibility/evaluator gates were selected.
- [ ] [[groom-personal-remote-relay-2026-08-01]] — explicitly deferred, not selected.

## Decisions

- This stage remains the sole ordering authority. Focused stages contain requirements and evidence so task text is not duplicated here.
- Remote access remains a separately selected security and operations project. A future selection must first resolve the trusted remote-client distribution boundary as well as the transport, protocol-review, and external-authority gates.
- Public deployment or infrastructure work is never implied by source implementation and still requires exact authorization.

## Verified

- Final repository validation passed 46 test files and 491 tests, including real Pi 0.83 no-model RPC/runtime integration, adversarial projection and Git fixtures, branch races, pagination races, extension dialogs, accessibility checks, and performance-gate witnesses.
- TypeScript, the production build, production-bundle instrumentation absence, and diff hygiene pass. The build retains only the documented chunk-size warning.
- A real Chromium smoke covered transcript math, settled search, slash completion, grouped model selection, Git status/diff, branch mode, and the 390 px responsive layout with no page overflow or console errors.
- Registry latest, manifest, lockfile, installed package, and terminal executable all resolve to Pi 0.83.0. `npm audit --omit=dev` still reports the one documented high-severity transitive `brace-expansion` advisory.

## Handoff

There is no selected product implementation stage. If remote access is selected later, begin with its threat model and trusted client distribution authority; do not let an opaque relay also serve mutable browser code.
