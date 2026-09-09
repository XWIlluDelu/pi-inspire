---
scope:
  - shared/assistant-stream.ts
  - shared/tool-argument-updates.ts
  - server/tool-argument-{stream,batches}.ts
  - server/runtime-{events,stream-budget,event-sockets}.ts
  - server/session-projection.ts
  - src/events.ts
  - src/controllers/connection-controller.ts
  - src/components/transcript-cards.tsx
  - src/tool-presentations/pi-native.ts
  - tests/{server,web}/**
---

# Streaming tool arguments

## Outcome

Implemented early named tool cards and bounded streaming argument previews, with
separate generation/waiting/execution/interruption states, incremental redaction,
exact append-byte budgets, same-tool batch coalescing, snapshot continuation, and
labelled/non-actionable partial content. No live Host restart or real file write
was performed for this task.

Evidence and limitations: [[streaming-tool-arguments]]. Decided contracts are in
[[activity-presentation]], [[session-transport]], and [[conversation]].

## Verification

- Node 22.23.2 full repository check passed before the concurrent dependency
  baseline upgrade: formatting/lint/types/unused/build, 17 portable tests,
  1,255 Vitest tests and six launcher tests; three pre-existing skips.
- Chromium repository suite: 34/34 passed on the same built working tree.
- Playwright CLI additionally inspected synthetic normalized tool receipt flows
  on the built mock Host at 1280px light and 390px dark: early shell, in-place
  code, generation/waiting/running/success, preview copy, resource gating,
  bounded 400-line content, and interruption. These checks did not use a live LLM.
- Real authenticated WebSocket fixture: 157,814 source bytes → 32,000-character
  preview → 18 batches / 39,191 incremental JSON bytes before compression, versus
  4,487,639 bytes for repeated cumulative replacements. Background viewer: no body.

## Final integrated verification and disposition

Complete; archived. Final integrated Pi 0.85.1 / Node 22.19.0 `npm run ci` passed:

- Formatting, lint, typecheck, Knip, and web build passed.
- Portable tests: 17/17.
- Vitest: 133 files, 1,257 passed and two skipped.
- Launcher: six passed and one skipped.
- Chromium: 34/34.

This includes the final failed-tool persistence parameterization and regression
requiring a full checkpoint whenever the item budget reduces the argument tree.
The latter also passed the focused Node 22.23.2 projection suites (105/105) before
the integrated gate.

The 2026-09-09 frontend follow-up corrected incomplete edit-item shape validation. Six initial
regressions failed; 22 edit-card cases then covered partial growth, interruption, fresh observers,
wrong types and final result adoption. Node 22.19.0 format/lint/types/Knip/build and the working-tree
suite passed (154 files, 1,571 passed, two skipped). Character-by-character desktop/narrow fixtures
verified typed diffs through the parser/shared-updates/registry path without a live model or file edit.
The reusable explanation is in [[streaming-tool-arguments]].

No implementation or design question remains open for this slice. The original backend delivery
requires Host restart and browser refresh; the edit-shape follow-up changes only frontend presentation.
No running Host was restarted by either task.
