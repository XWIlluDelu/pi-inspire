---
purpose: Reproduced asynchronous ownership defects, their repairs, and the approved session-addressed Fork correction.
---

# Asynchronous ownership review

## Scope

The 2026-09-22 review started at `f5fdd30`. It inspected session selection,
bootstrap/reconnect, transcript reads, runtime controls, History requests,
composer/resource/Git ownership, Host projection reconciliation and worker
reclamation, and terminal transport. It authorized demonstrated correctness and
implementation-quality repairs, not unapproved product-design changes.

## Reproduced and repaired

The first ten added cases failed against the starting implementation. Thirteen
new regression cases now cover the repaired boundaries and their related cases:

- **Late bootstrap replaced a newer committed snapshot.** Completing open,
  create, or deselect while reconnect bootstrap waited caused the old bootstrap
  selection to win; a same-session resync could also be overwritten. `AppStore`
  now fences the snapshot portion by the snapshot publication generation.
  Current Host metadata can still refresh, but an obsolete snapshot digest cannot
  attest the retained view. Launch continuation uses the intent captured before
  bootstrap, not an intent captured after it returns.
- **History remained permanently busy after ordinary append.** A changed
  effective leaf invalidated a tree/action result without advancing its request
  id; the old completion also refused to clear its loading/action marker.
  `BranchController` now separates ownership of the request marker from authority
  to publish its result. A still-owned request retires its marker and exposes a
  refreshable stale-history state; invalidated requests cannot clear newer work.
- **An old model change suppressed a current session refresh.** After selecting B,
  a completed model request from A started a new A resync and advanced the shared
  request counter. B's already-running refresh then discarded its valid result.
  Model changes capture their original selection generation, and `resync` rejects
  obsolete owners before allocating a request or issuing HTTP.
- **Thinking-level refusal rolled back a reopened selection.** A delayed failure
  from before A → B → A restored the old optimistic predecessor into the reopened
  A. Rollback now also requires the captured selection generation.
- **An old abort error appeared in the current view.** A delayed abort failure
  could replace B's error, or the error of a reopened A or a new same-session
  branch. Visible errors now require the captured selection owner; session-owned
  command activity remains attributable to its original operation.

Current-API authentication failures retain their transport-wide meaning. The
repairs neither cancel accepted Host operations nor add replay/retry fallbacks.
Implementation: `src/store.ts` and `src/controllers/branch-controller.ts`.
Regression evidence: `tests/web/store-async-ownership.test.ts` and
`tests/web/branch-store.test.ts`.

## Approved follow-up — session-addressed Fork

The reviewed implementation required `RuntimeController.selectedSessionId === source.id`
inside `forkBranchInside`, while event subscriptions and snapshots were addressed
per browser. An isolated runtime probe reproduced this sequence:

1. Open A, then open B as a second browser would.
2. An addressed snapshot of A succeeds without changing the Host selection.
3. Fork A refuses with `Fork requires the source session to remain selected`.

The user approved replacing this admission policy with session-addressed Fork.
`forkBranchInside` now validates the addressed source and its fresh branch
revision, retaining source identity, conflict, active-path user target,
committed-prefix, and publication checks. The contract is in [[session-branches]].

Two related lifecycle details matter:

- Capture the automatic-selection fence before entering the source operation
  lane. Capturing it only after reconciliation lets a queued fork overwrite a
  newer selection made while it waited.
- Warm the attached destination independently of global selection, as ordinary
  `openSession` does. The requesting browser can adopt that addressed preview
  even while another session remains globally selected; skipping warm-up leaves
  the destination without runtime metadata and eligible for dormant reclamation.

Four added runtime regression cases failed before this repair. They cover a
source viewed while another session or no session is globally selected, newer
selection during a queued fork, and retained source validation. The expanded
active-source test also checks unchanged source bytes, worker/queue/dialog
continuity, destination readiness, and no unexpected global selection change.

Follow-up verification: **194 tests passed across six files** covering runtime,
branching, independent fork publication, trees, HTTP/WebSocket behavior, and
browser branch ownership. Typecheck, formatting, lint/import-boundary, whitespace,
and DocDoki privacy checks passed. These are isolated fixture checks, not a new
live-provider or real multi-browser Chromium run. No running Host was restarted.

## Rejected reconnect hypothesis

The initial runtime probe also disproved a suspected reconnect gap: `RuntimeController.snapshot`
already reconstructs an absent or LRU-reclaimed slot through the catalog and
`prepareSlot`, without changing global selection or starting a worker. Reading
only its lower-level `RuntimeReadController` delegate misses that boundary. No
extra browser reopen fallback was retained.

## Initial review verification and limits

- Typecheck and production Web build passed.
- Full Vitest run: **160 files, 1,664 passed, 2 skipped**; the final repairs add
  **13 cases**. Existing Host persistence, terminal, and streaming-budget checks
  are included, but this is not a live-provider end-to-end run.
- Production-build Chromium gate: **44 passed**, using an isolated source copy,
  fixture home/workspace, and separate loopback port. No running user Host or
  terminal service was restarted or replaced.
- Formatting, lint/import-boundary checks, unused-code analysis, diff whitespace,
  and DocDoki privacy checks passed. No worthwhile dead-code or architecture
  cleanup was established beyond simplifying the affected request-ownership checks.
- Streaming byte/work bounds and browser interactions were checked; no new
  latency bottleneck was established. No real remote-network latency comparison
  was performed, so this review makes no measured local/remote speedup claim.
