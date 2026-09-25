---
scope:
  - server/runtime*.ts
  - server/pi-rpc.ts
  - server/herdr-*.ts
  - server/index.ts
  - tests/server/runtime*.test.ts
  - tests/server/herdr-*.test.ts
  - tests/server/pi-rpc*.test.ts
---

# Worker retirement and Herdr boundaries

## Objective

Close the reviewed lifecycle, topology, and status-projection gaps in
[[herdr-enhancement]] and [[pi-integration]], without changing the RPC bridge,
normal restart semantics, or the single Runtime ownership model.

## Outcome

Completed the approved worker-boundary review. The missing abnormal-exit and
idle-eviction fences also existed in the `4e4f7f0` baseline; Herdr's explicit
disconnect/exit distinction made the integration gap consequential.

- Explicit stop, unexpected exit, and idle eviction now share worker retirement.
  Authority and event ownership retire synchronously. Pending stops prevent a
  replacement factory call; rejected stops remain attached to the slot and
  cannot be cleared by pool reclamation.
- Final integration review found the same problem in failed provisional
  creation. Cleanup now uses that retirement path and retains its existing
  reservation on unconfirmed stop, including when native file identity was not
  reported. Catalog admission waits for the stop or receives its failure.
  Fork destinations are registered before warming and already use the ordinary
  slot fence; no separate lifecycle layer was introduced.
- Definite `pane_not_found` retires local topology after process termination.
  Definite cached `workspace_not_found` permits one fresh allocation; other
  failures do not. Older cleanup does not discard a newer workspace.
- An unconfirmed stop during Pi RPC unknown-outcome recovery preserves unknown
  classification; it cannot imply that a potentially accepted mutation failed.
- Runtime emits a narrow, process-bound status projection from its canonical
  run state and pending extension UI. Herdr maps it to idle/working/blocked,
  coalesces reports, and leaves identity metadata until physical cleanup.
  Raw Pi events no longer drive a second Herdr state machine.

## Verification

- Relevant checks passed in Runtime, branching, projection, Herdr client/enhancement/
  transport/status/observer, and Pi RPC protocol/ownership suites. Existing fixtures
  were reused; added cases target delayed/rejected stops, provisional reservation
  retention, external workspace closure, uncertain allocation, and input status.
- `npm run typecheck` and `tsc --noEmit -p tsconfig.release.json` passed.
- Targeted Biome and `git diff --check` passed.
- This repair run used controlled boundary fixtures, not another live Herdr/Pi
  smoke run, browser run, benchmark, release installation, or systemd restart.
  Earlier real-Pi/crash-recovery evidence remains in
  [[follow-herdr-enhancement-2026-09-25]] and is not presented as proof of these
  previously uncovered paths.

No deployment or running-service restart occurred. No new scheduler, generic
orchestration framework, live TUI attachment, or cross-restart Pi survival was
introduced. No follow-up implementation remains for this review.
