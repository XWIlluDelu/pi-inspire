---
purpose: Separate asynchronous request ownership, result authority and session addressing so late completions cannot replace newer work.
---

# Asynchronous selection ownership

## Request ownership and result authority differ

A request can still own its loading marker after its result has become stale. `BranchController`
clears a still-owned marker when the effective leaf changes, but does not publish the stale History
result. Invalidated requests cannot clear a newer request's marker. Conflating those checks formerly
left History permanently busy after an ordinary append.

Selection identity includes its generation, not only the session ID. A → B → A is a new owner:
late thinking rollback, abort errors and model-change refreshes from the first A cannot publish into
the second. `AppStore.resync` rejects an obsolete owner before allocating a request, so an old A
completion cannot invalidate a valid B refresh.

Bootstrap has a related publication boundary. An open/create/deselect or same-session resync can
commit while reconnect is pending. Metadata may still refresh, but the old snapshot and its digest
cannot attest the retained view. Launch continuation uses the intent captured before bootstrap.

Source and regression evidence: `src/store.ts`, `src/controllers/branch-controller.ts`,
`tests/web/store-async-ownership.test.ts` and `tests/web/branch-store.test.ts`. The original regressions
failed before repair; [[challenge-runtime-review-2026-09-22]] holds that run's outcome and scope.

## Addressed operations are not global selection

A browser can view A while another browser selects B. An addressed snapshot of A must not require a
Host-global selection change. Fork likewise validates the addressed source and fresh branch revision;
its persistence and publication checks remain independent of global selection. The decided contract
is [[session-branches]].

Capture automatic-selection intent before entering the source operation lane. Capturing it after a
queued reconciliation can overwrite a newer selection made while the operation waited. Warm the
attached destination independently of global selection, as ordinary open does, so its addressed
preview receives runtime metadata and does not become eligible for dormant reclamation.

`tests/server/runtime-branching.test.ts` covers another/no global selection, a newer selection during
queued Fork and retained source validation. Delivery evidence: [[follow-addressed-forks-2026-09-22]].

## Inspect the public boundary before adding recovery

`RuntimeController.snapshot` reconstructs an absent or reclaimed slot through the catalog and
`prepareSlot`, without selecting it or starting a worker. Inspecting only the lower-level read
delegate once suggested a nonexistent reconnect gap. No additional browser reopen fallback was
needed. The distinction also applies to model discovery: [[model-discovery-ownership]].
