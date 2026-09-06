---
scope:
  - src/events.ts
  - src/components/AssistantError.tsx
  - src/components/transcript-row-projection.tsx
  - src/styles/transcript.css
  - server/session-projection.ts
  - server/mock.ts
  - tests/web/assistant-error.test.tsx
  - tests/web/transcript-inspection.test.tsx
  - tests/server/session-projection.test.ts
  - tests/server/runtime-projection.test.ts
  - tests/browser/assistant-error.spec.ts
---

# Pi error message display

## Objective

Show the errors already present in Pi terminal conversations in INSΠRE at the failed reply, including empty replies, retained partial output, expandable/copyable details, and recovery from Pi history. Contract: [[conversation]]. This is presentation parity, not a new connection-diagnostic or retry-management system.

## Current state

- Implemented message-owned error rows outside activity folding, with plain-text details and existing clipboard feedback.
- Host paging treats failed assistant messages as visible boundaries; bounded message projection retains error metadata even when other fields are omitted.
- Complete. Pi failures now retain their message-owned error details in live events, reconnect snapshots, persisted history, and deferred older-history paging. No change to retry, abort, or connection-diagnostic behavior.

## Verification

- Linux, explicitly verified Node 22.23.2: full Vitest suite passed (1,155 tests; one existing skipped test), including live RPC-to-projection error forwarding/adoption, JSONL close/reopen and paging through 130 failed messages, empty/mixed replies, plain-text disclosure, and complete available-text copying.
- All 18 Chromium browser tests passed. The new fixture exercises reopening/reload, clipboard while collapsed, keyboard disclosure, 390px/1280px layouts, Amber/Jade light/dark palettes, and scoped axe checks. Screenshots under ignored `output/playwright/pi-error-*.png` were visually reviewed at desktop and narrow widths.
- Typecheck, lint, format check, unused-code check, production web build, and DocDoki private-boundary check passed.
- Browser checks use deterministic Pi-message fixtures, not an induced provider outage. The running personal Host was not restarted; the built browser assets are updated, and the Host-side older-history paging change loads at its next restart.
