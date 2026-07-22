---
scope:
  - server/session-catalog.ts
  - server/session-preview.ts
  - server/runtime.ts
  - shared/contracts.ts
  - src/store.ts
  - tests/server/**
  - tests/web/store.test.ts
  - docdoki/specs/session-continuity.md
---

# Session-switch latency correction

## Objective

Make conversation selection feel immediate without stopping background sessions, disabling extensions, weakening Pi authority, or creating a second conversation store.

## Current state

- Measured baseline: constructing a new Pi RPC worker with the configured extensions takes about 5,490 ms; the same worker without extensions takes about 302 ms.
- Measured baseline: a cold session-catalog scan takes about 749 ms, while a hot identity lookup is effectively immediate.
- Measured corrected critical path: read-only projection of the largest listed session (47,071,711 bytes and 3,146 entries) into its active 302-message branch plus safe JSON projection takes about 115 ms.
- Implemented: the open route returns that Pi-derived preview before extension startup completes, then the selected worker’s `runtime_ready` event reconciles authoritative RPC state.
- Implemented: preview loading, slot creation, and process startup are single-flighted per session; prompt and control operations capture their owning slot and await readiness.
- Implemented: delayed resyncs are guarded by session identity and selection generation; readiness arriving before the open response is retained and reconciled afterward.
- Implemented: extension responses carry owning session identity, dead workers clear stale dialogs while retaining a recovery preview, and selected-only extension presentation is cleared on navigation.
- Verified on the real local host after restart: two unopened saved sessions returned their previews in about 10.0 ms and 9.2 ms; returning to an already-ready session took about 2.5 ms. The configured extension runtime completed about 7.9 seconds later without blocking conversation display.

## Next actions

- [x] Return a read-only active-branch preview from Pi’s session format before an unopened worker finishes starting.
- [x] Warm the independent worker asynchronously, then reconcile the selected view from its authoritative RPC state when ready.
- [x] Make prompt and control actions await the owning worker when preparation is still in flight.
- [x] Reuse catalog identity records for direct opens instead of forcing a cold global rescan after normal invalidation.
- [x] Verify concurrency, extension-dialog ownership, error handling, focused latency behavior, full tests, production build, and DocDoki integrity.

## Decisions

- Session JSONL remains authoritative. The preview uses Pi’s exported parser, in-memory migration, and active-branch context builder and never writes the file.
- Preview state is temporary: once the worker is ready, normal RPC snapshots and live events replace it.
- Extensions remain enabled. Their measured startup cost is moved off the conversation-selection critical path rather than hidden with extension-specific suppression or fallback behavior.
- Background workers and their status indicators retain the concurrency contract from [[session-continuity]].

## Handoff

The latency correction is complete. Focused tests cover preview immutability, nonblocking open, duplicate-open single-flight, action readiness, worker-exit recovery, extension ownership, stale-resync rejection, and early readiness ordering; the full suite, production build, real-host timing smoke, and DocDoki checks pass. Do not alter the unrelated enhancement proposal, visual experiments, or extension configuration.
