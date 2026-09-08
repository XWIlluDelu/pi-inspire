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

Complete; archived. On the final frozen source with Pi 0.85.1, the concurrent
baseline-update session ran `npm run ci` under Node 22.19.0 and supplied the log
`/tmp/inspire-pi-0851-final-ci.log`, inspected again during this closeout:

- Formatting, lint, typecheck, Knip, and web build passed.
- Portable tests: 17/17.
- Vitest: 133 files, 1,257 passed and two skipped.
- Launcher: six passed and one skipped.
- Chromium: 34/34.

This includes the final failed-tool persistence parameterization and regression
requiring a full checkpoint whenever the item budget reduces the argument tree.
The latter also passed the focused Node 22.23.2 projection suites (105/105) before
the integrated gate. npm emitted its Node-version support warning with the
baseline session's npm 12/Node 22.19 combination; every CI command completed.

No implementation or design question remains open for this slice. Activation of
the already running Host is deliberately separate: restart and browser refresh
are required, and were not performed here to avoid interrupting active work.
