---
scope:
  - server/runtime.ts
  - server/runtime-slot.ts
  - server/runtime-projection-coordinator.ts
  - server/runtime-worker-lifecycle.ts
  - tests/server/runtime-projection.test.ts
  - tests/server/runtime-branching.test.ts
  - tests/server/pi-compat.integration.test.ts
  - docdoki/specs/session-continuity.md
  - docdoki/specs/pi-integration.md
---

# Worker witness race

## Objective

Replace active-worker final-leaf snapshot equality with exact observed-prefix ownership while preserving fail-closed divergence detection and correctly consuming persistence expectations that arrive during witness lookup.

## Current state

- Complete: active-worker ownership accepts an exact observed prefix without requiring asynchronous final-leaf equality.
- Complete: witness-time claims are consumed only through the observed disk prefix; worker-only trailing claims remain queued for later reconciliation.
- Complete: deterministic race, divergence, diagnostics, and real-Pi memory-boundary coverage pass.

## Completed work

- [x] Implemented exact-prefix witness ownership and bounded late-expectation consumption.
- [x] Added immutable worker-ahead diagnostics and corrected the user-facing ownership failure claim.
- [x] Replaced the invalid trailing-witness test and added deterministic race and divergence coverage.
- [x] Added a real-Pi compatibility witness for the live worker memory boundary.
- [x] Reconciled the session-continuity and Pi-integration contracts and ran focused checks.

## Decisions

- A witness proves only the disk entries in the current reconciliation result; worker-only trailing entries remain for later disk reconciliation.
- Snapshot quiescence, debounce tuning, worker suspension, and retry-until-equal are not ownership requirements.
- Startup attestation remains outside this change until its distinct startup boundary is reproduced and reviewed.
