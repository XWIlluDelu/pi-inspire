---
scope:
  - server/runtime.ts
  - tests/server/runtime-branching.test.ts
  - docdoki/specs/session-branches.md
---

# Session-addressed forks

## Outcome

Implemented the user's approved review recommendation. Fork admission uses the
addressed source session and its fresh branch revision, not global selection.
Source/persistence/publication checks remain intact. The destination warms
independently, and automatic selection honors intent newer than request dispatch,
including time spent waiting in the source operation lane.

Four added runtime cases failed before the repair and now pass. The targeted
six-file gate passed all 194 tests; typecheck, formatting, lint/import boundaries,
whitespace, and DocDoki privacy checks passed. The running Host was not restarted.

Current contract: [[session-branches]]. The addressing and selection-fence rationale is in
[[async-ownership-review]]. These were isolated fixture checks, not a live-provider or real
multi-browser Chromium run. No implementation work remains for this correction.
