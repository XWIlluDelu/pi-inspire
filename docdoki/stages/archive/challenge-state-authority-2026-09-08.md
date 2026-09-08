---
scope:
  - src/{store,events,app-state}.ts
  - src/components/{ActivityBar,CommandActivity,Composer,Settings}.tsx
  - src/controllers/update-controller.ts
  - server/{runtime,runtime-slot,runtime-events}.ts
  - shared/contracts.ts
  - tests/{web,server}/**
---

# State authority review

## Objective

Generalize the compaction feedback defect and repair confirmed instances across the project: current domain state must not depend on the initiating command, a local HTTP promise, or having witnessed a start event. Requests and outcomes retain their appropriate ownership. The user authorized in-scope repairs after initially requesting a read-only review.

## Final state

Completed four repairs: state-owned compaction progress; reconstructable retry details with a detail-independent phase label; separate update-request pending and Host checking; explicit Host run state outranking event-name inference. The earlier CommandActivity fallback was replaced rather than retained.

Node 22.19.0 complete suite: 135 files, 1298 tests passed, 3 skipped. Typecheck, lint, format, unused checks, and production web build passed. Chromium checked state-injected production UI at desktop light and narrow dark/Jade sizes, including retry restoration across reload. No daily-use Host/Pi process was restarted and no real provider error/compaction was induced.

The reusable abstraction, four findings, other reviewed boundaries, regression evidence, and verification limits live in [[state-authority-review]]. Decided contracts are in [[composer]], [[session-transport]], [[interface-preferences]], and [[workspace-layout]]. This is a bounded ownership-path audit, not a claim that every project path is defect-free. No known repair obligation remains open in this stream.
