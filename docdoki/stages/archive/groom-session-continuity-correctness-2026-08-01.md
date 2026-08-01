---
scope:
  - server/pi-rpc.ts
  - server/session-preview.ts
  - server/session-projection.ts
  - server/runtime.ts
  - server/app.ts
  - shared/contracts.ts
  - src/api.ts
  - src/events.ts
  - src/store.ts
  - src/components/Transcript.tsx
  - tests/server/**
  - tests/web/**
---

# Session-continuity correctness

## Objective

Make long histories bounded end to end and follow externally persisted Pi entries at message-level latency without weakening the malformed-child guard or creating concurrent session writers.

## Outcome

- `SessionProjection` is the one read-only authority over Pi JSONL. It incrementally parses complete lines, retains partial tails, validates identity and append lineage, rebuilds Pi branch context, and publishes bounded revisioned pages with incarnation- and view-bound cursors.
- Settled snapshots, transcript paging, resource discovery, branch views, and reconnect reconstruction no longer depend on aggregate `get_messages`. Live events use a bounded correlated overlay until persistence absorbs them.
- Watch notifications are hints backed by stat/poll reconciliation. Append, missed watch, partial line, rewrite, truncation, replacement, compaction, old-ancestor branch, and close races retain either a complete last-good projection or an attributable error/conflict.
- Every persistence-capable runtime operation passes through the slot mutation FIFO and a forced freshness check. Idle stale workers are replaced; busy external divergence stops the writer and enters a visible conflict rather than merging or retrying an unknown outcome.
- Startup accepts only the narrowly attested, state-equivalent missing `thinking_level_change` delta that Pi 0.83 may create. A second pre-start baseline rejects factory-time writes; the public RPC boundary cannot prove authorship of an exactly equivalent forbidden concurrent append afterward, so the external one-writer rule remains explicit.
- Older-page prepends preserve the visible anchor, loaded history survives live snapshots, same-session responses cannot regress newer revisions or cross branch views, and conflict/projection failures remain visible through resync and recovery.

## Decisions

- The independent 8 MiB malformed-child JSONL guard remains unchanged; valid long sessions avoid aggregate RPC frames instead of receiving a larger exception.
- Pi JSONL remains canonical and inspire never writes it directly. Filesystem observation does not authorize a second writer.
- Persistence provenance is exact and ordered. Expected operations never authorize interleaved entries merely by entry type or timestamp resemblance.
- Projection, overlay, mutation, event, extension-response, paging, and shutdown ownership are serialized at their narrowest coherent boundaries.

## Verified

- Frozen fixtures cover a session larger than the child frame limit and browser page, malformed unterminated child output, large/deep branches, partial lines, same-size rewrites, truncation/replacement, compaction, equal-timestamp messages, projection eviction/incarnation, close races, and external divergence before and during writes.
- Focused projection/runtime/RPC/app/store/transcript tests pass, including real Pi 0.83 no-model startup, navigation, fork, and dialog-lane integration.
- The completed work is included in the final repository-wide 491-test validation, TypeScript check, production build, real Chromium smoke, and diff hygiene. Its frozen performance evidence remains recorded by [[groom-evidence-gated-maintenance-2026-08-01]].

## Residual boundary

Two independent Pi processes still must not write one session concurrently. Public RPC cannot causally distinguish a forbidden append that is byte-for-byte and state-equivalent to Pi's one allowed startup initialization delta; this operating rule is not weakened or represented as causal attestation.
