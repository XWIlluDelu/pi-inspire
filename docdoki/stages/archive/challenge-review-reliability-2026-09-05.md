---
scope:
  - src/terminal-*.ts
  - src/components/TerminalView.tsx
  - src/store.ts
  - src/api.ts
  - src/controllers/connection-controller.ts
  - src/controllers/runtime-event-controller.ts
  - server/app.ts
  - server/runtime*.ts
  - server/session-projection.ts
  - shared/contracts.ts
  - shared/assistant-stream.ts
  - tests/server/**
  - tests/web/**
---

# Review reliability and streaming costs

## Objective

Resolve the eight-item review of `0c7b390` without replacing Pi authority or the existing workbench architecture. This cross-cutting review is separate from the existing native-command and Settings design stages; its Pending scope supersedes the unimplemented companion-protocol work.

## Outcome

All eight review items are implemented. Terminal phase/liveness recovery retains input continuity; setting rollback is field-owned; `/copy` reads full authoritative branch text; file links use real xterm cells. Socket-local detail interests and snapshots preserve independent browser subscriptions, while incremental overlay accounting removes cumulative-message serialization from valid deltas. Unsupported Pending management is removed in favor of public queue events and confirmed `clear_queue`. Projection substitutes live in tests and no longer bypass production filesystem or reconciliation semantics.

Standing contracts are reconciled in the terminal, composer, conversation, Pi integration, and session continuity specs. [Performance evidence](../../notes/performance-evidence.md) distinguishes measured serialization work from unmeasured application/remote latency.

## Validation

- Typecheck, lint, Knip, and web build passed.
- Vitest: 118 files passed; 1,131 tests passed and one environment-gated test skipped.
- Installed public Pi 0.85.0: two compatibility tests passed without model inference, including actual queue events and `clear_queue`.
- Chromium: terminal detach/restore/multiple viewers, explicit Pending clearing, session-transition input ownership, and active steer/queue/abort flows passed.
- Terminal stall tests use controlled time; Unicode coordinates use real headless xterm cells. Long-copy tests retain the 70,000-character tail and reject stale branch/browser ownership.
- No real SSH outage or remote-link latency benchmark was performed; no user-visible speedup percentage is claimed.

## Decisions

- Follow public Pi, not an untraceable fork. Pause, item deletion, conversion, and custom exact-Pending-text RPC are not current product capabilities.
- Keep presentation limits. Full assistant copy reads authoritative branch content through the Host rather than expanding the browser transcript budget.
- Report serialization and frame work separately from latency; isolated work counters do not establish remote-user speedups.
