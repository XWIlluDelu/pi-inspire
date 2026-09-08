---
purpose: Explain ordered projection reconciliation, content-equivalent metadata observations, and the limits of persistence attribution.
---

# Projection reconciliation ownership

## Finding

Awaiting an old queue tail does not join its transaction. Explicit reconciliations formerly waited
for `RuntimeSlot.projectionTail`, but their read, asynchronous ownership witness, and baseline commit
were not in that FIFO. Another read could replace the projection while the first witness waited,
causing two legitimate appends to be compared against the same old writer baseline.

A separate path treated changed stat metadata with unchanged committed contents as `not-append`.
That is not proof of a content mutation. Raw `stat` fields can also be observed at different points
in a concurrent append; such an experiment alone does not reproduce the reader's complete
before/after validation. The exact filesystem origin of the reported timestamp movement remains
unestablished. Synthetic full-reader tests establish the observation's handling independently of
that origin.

This extends [[operation-lifecycle-ownership]]: a file observation, pending verification, and
permission to advance the current writer baseline must remain distinct. The decided contract is
[[session-persistence]].

## Implementation

- `SessionProjection` binds an asynchronous Host reconciliation consumer inside the same FIFO as
  the physical read. Explicit calls, watch/poll hints, and watch-health failures cannot bypass a
  pending ownership check. Hints retain one pending read and a coalesced dirty indication rather
  than accumulating a read for each event. Retired watchers cannot publish new health failures.
- `RuntimeProjectionCoordinator` no longer maintains an independent post-read handler queue.
  `projectionTail` tracks the current consumer for lifecycle draining; the projection's FIFO owns
  read/consume ordering. Diagnostics use the observation's captured byte counts, not a later
  mutable projection. Consumer rejection still reaches the explicit caller and the runtime log.
- Suspended startup reads remain owned by the startup attestor. Ordinary reads recheck suspension
  after waking, and the FIFO drains consumers before the startup boundary proceeds. Startup's
  identity/stat equality requirement is unchanged.
- Post-await worker/projection checks prevent retired witnesses and deferred receipts from
  repopulating baselines, consuming claims, or creating a new conflict after Stop. Claim consumption
  uses matched identities: cancelling an earlier matched claim while a later receipt waits cannot
  remove an unrelated future claim from the queue.
- Empty overlays have an O(1) reconciliation path, avoiding a full persisted-message scan during
  unchanged polling observations.

## Content-equivalent metadata boundary

The reader supplies `verifiedUnchangedContent` only after a stable, full-byte revalidation of the
same object with no old or new incomplete tail. An owned-prefix shortcut cannot supply that proof.
The coordinator additionally requires the exact existing writer baseline, healthy state, and no
conflict or pending partial lease before refreshing the source version.

The `projection_metadata_revalidated` diagnostic records only identities, versions, revision, and
byte counts. This is acceptance of unchanged state, **not** evidence of who changed the timestamps.
It does not consume a persistence expectation, accept a new entry, change the history/view, or
reauthorize a conflicted writer. It is independent of running, compacting, or idle presentation.

A completed in-place write of identical bytes also satisfies this state-equivalence proof. The old
blanket wording that every same-byte rewrite must be rejected was too broad for this boundary;
[[session-persistence]] now explicitly distinguishes it from content changes, object replacement,
and incomplete-tail rewriting. Startup retains its stricter source-version comparison, and the
pre-existing bounded new-file materialization handling is not broadened into a partial-tail lease.

## Verification

All session contents in the evidence are synthetic temporary fixtures. No live conversation JSONL,
compaction summary, or remote provider content was read, and no daily-use service was restarted.

- The initial Node 22.19.0 regression run had 6 failures among 12 cases on the old production path:
  overlapping explicit reads, a late Stop witness, three metadata-state cases, and continuation
  after a synthetic compaction. The remaining negative controls passed.
- After implementation, `runtime-projection-coordinator.test.ts`, `runtime-projection.test.ts`, and
  `session-projection.test.ts` pass together: **113 tests**. These include 18 coordinator cases for
  explicit/hint ordering, hint coalescing, queued watch failure, projection/worker retirement,
  deferred-claim cancellation, running/compacting/idle metadata revalidation, retained compaction
  followed by another owned append, startup bypass, stale baseline, and incomplete-tail rejection.
- Real filesystem controls still reject atomic identical-byte replacement, changed bytes, foreign
  appends, and same-byte incomplete-tail changes. Runtime-level tests retain the same worker after
  a complete identical-byte in-place rewrite and verify subsequent prompt dispatch; replacement
  still stops a busy writer or retires an idle writer before another starts.
- Final `npm run ci` passes with **Node 22.19.0 / npm 10.9.2**: formatting, lint, typecheck,
  unused-code checks, and production web build; **1,482 Vitest tests passed, three skipped**
  (1,473 ordinary plus nine launcher tests); **17 portable checks** and **36 Chromium tests** passed.
  The suite includes real Pi's 35-second preflight compaction and subsequent same-worker prompt,
  plus extension confirmation and explicit Stop through the isolated API/Host/runtime.
- DocDoki's private-boundary checker and `git diff --check` pass. These changes and the earlier
  lifecycle repairs were validated together; loading the new Host code is a separate deployment action.

The tests demonstrate the ordering repair and the full-reader metadata boundary. They do not claim
that the original filesystem timing sequence or its actor has been identified, nor that all
compaction failures from remote models or extensions are eliminated.
