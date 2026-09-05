---
scope:
  - docdoki/specs/composer.md
  - docdoki/specs/conversation.md
  - docdoki/specs/pi-integration.md
  - shared/contracts.ts
  - server/runtime-pending.ts
  - server/runtime-pending-controller.ts
  - src/components/transcript-rows.tsx
  - tests/server/pi-compat.integration.test.ts
  - tests/shared/pending-contracts.test.ts
---

# Pending input management — superseded

## Outcome

The review of `0c7b390` explicitly chose the public Pi boundary over the dormant companion-protocol design. The pause/resume, item identity/revision, single-item deletion/conversion, structured-content, and exact-text-pagination requirements from this stage are withdrawn. They are not a release gate or an active future commitment. Git history retains the earlier design.

Public Pi 0.84.4 provides `queue_update` text arrays, `pendingMessageCount`, and `clear_queue`. The current implementation projects bounded Steer/Queue text summaries and supports explicitly confirmed clear-all through that real RPC. It does not probe or emulate unsupported management commands, claim that preview IDs are Pi identities, or copy a truncated queue preview as full text. Raw Abort/Escape remains independent of clearing.

The installed-Pi compatibility suite covers text queue updates and real clear-all behavior without paid inference. No fork-only protocol is accepted through Fake RPC tests.

## Continuation

The contraction and validation belong to [the review reliability stage](./challenge-review-reliability-2026-09-05.md). Standing behavior lives in the composer, conversation, and Pi integration specs; there are no remaining companion-Pi acceptance tasks here.
