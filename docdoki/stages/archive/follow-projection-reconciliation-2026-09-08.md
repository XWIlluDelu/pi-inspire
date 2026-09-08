---
scope:
  - server/session-projection.ts
  - server/runtime-projection-coordinator.ts
  - server/runtime-persistence-ownership.ts
  - tests/server/runtime-projection*.test.ts
  - tests/server/session-projection.test.ts
  - tests/server/fixtures/preview-projection.ts
  - docdoki/specs/session-persistence.md
  - docdoki/notes/projection-reconciliation-ownership.md
  - docdoki/spec_abstract.md
---

# Ordered projection reconciliation

## Objective

Repair confirmed reconciliation ordering gaps and distinguish fully verified content-equivalent
source metadata from new persistence, without weakening startup, incomplete-tail, replacement,
or unowned-entry checks in [[session-persistence]]. The user authorized implementation after the
source review. Only isolated synthetic session fixtures may be read; no real conversation payloads
or compaction summaries, and no daily-use service restart.

## Final state

Completed 2026-09-08. Rationale, contract refinement, regressions, and limits are retained in
[[projection-reconciliation-ownership]].

- Explicit reads, watch/poll hints, and watch errors now share one FIFO through the asynchronous
  Host consumer and baseline commit. Hints coalesce, retired watchers cannot publish errors, and
  suspended startup retains its own attestation boundary.
- Healthy, complete, same-object bytes may refresh source metadata only after full revalidation
  and an exact prior writer-baseline match. This proves unchanged state, not who changed metadata;
  it also admits complete identical-byte in-place writes. No append claim, history/view revision,
  or conflict is consumed or reset. Replacement, changed bytes, foreign appends, stale baselines,
  and incomplete-tail rewriting remain fenced.
- Retired workers/projections cannot consume late receipts or commit old baselines. Matched claims
  retire by identity rather than deleting a count of current queue heads after an asynchronous wait.

## Verification

- Initial red regression: six failing cases among 12 on the old path, with negative controls passing.
- Targeted real-filesystem/projection/runtime suite: **113 tests passed**, including 18 new
  coordinator regressions.
- Final `npm run ci`, Node **22.19.0** / npm **10.9.2**: **1,482 Vitest tests passed, three skipped**;
  **17 portable checks** and **36 Chromium tests** passed. Formatting, lint, typecheck, unused-code
  checks, and production web build passed.
- Real Pi's isolated 35-second preflight compaction, same-worker continuation, extension confirmation,
  and explicit Stop remain covered in the full suite. DocDoki privacy and diff checks passed.

No implementation obligations remain in this stage. The precise filesystem timing/actor behind the
reported metadata transition remains unestablished; the verified handling uses synthetic complete
reader observations, not a claimed reproduction of that causal sequence. Native Windows/macOS and
remote providers were not exercised.

## Deployment boundary

No real session content was read and no daily-use service was restarted. Prior uncommitted lifecycle
repairs were preserved. This stage includes no commit, push, release, or deployment; loading the new
Host code remains a separate action.
