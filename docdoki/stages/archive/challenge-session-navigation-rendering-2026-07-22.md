---
scope:
  - shared/contracts.ts
  - server/runtime.ts
  - server/mock.ts
  - server/pi-rpc.ts
  - tests/server/**
  - src/App.tsx
  - src/ansi.ts
  - src/events.ts
  - src/store.ts
  - src/components/CommandPalette.tsx
  - src/components/Nav.tsx
  - src/components/Settings.tsx
  - src/components/Transcript.tsx
  - src/styles.css
  - tests/web/**
  - docdoki/northstar.md
  - docdoki/specs/pi-integration.md
  - docdoki/specs/session-continuity.md
  - docdoki/specs/workbench.md
  - docdoki/specs/conversation.md
---

# Session navigation and rendering correction

## Objective

Correct three observed daily-use problems without adopting unrelated enhancements: replace view-coupled runtime replacement with concurrent session ownership while retaining the Remnic diagnosis, group sessions by project folder and show per-session attention state while moving preferences into a simple settings-page draft, and remove terminal control formatting from displayed Thinking content.

## Current state

- Implemented: every session opened by inspire retains an independent Pi RPC worker; selecting another row changes the visible projection without stopping background work.
- Implemented: runtime events carry per-session status, and navigation shows yellow while running, green after unseen successful completion, and red after unseen error completion. Opening the conversation clears completion attention.
- Implemented: sessions are grouped by exact working directory and sorted newest first within each folder; persistent preferences moved into a dedicated settings draft.
- Implemented: Thinking presentation strips CSI and OSC terminal sequences at the rendering boundary without modifying Pi history.
- Recorded: repeated runtime replacement was the host trigger for Remnic `session_shutdown` backfills and `write_rate_limited`; no Remnic configuration, suppression, retry, or extension code was changed.
- Preserved: pre-existing launcher and Escape-key changes and the unreviewed enhancement-proposal note remain outside this objective.

## Next actions

- [x] Give each opened session an independent long-lived Pi worker so selecting a row changes only the observed session and never stops background work.
- [x] Track and publish yellow running, green unseen-success, and red unseen-error state per session; clear completion attention when that session is viewed.
- [x] Group folder sections and time-sort their sessions; move persistent preference controls into a simple settings-page draft.
- [x] Strip terminal presentation sequences only at the Thinking display boundary while preserving canonical Pi session content.
- [x] Verify focused behavior, full tests, production build, and real-host smoke behavior.
- [ ] After human review, optimize the settings-page draft in a separate explicitly approved task.

## Decisions

- Session selection is a view operation, not a runtime lifecycle operation. Each concurrently active session owns a distinct runtime, matching the process-per-slot pattern used by established Pi web clients.
- Yellow means currently working; green means completed successfully outside the visible session and not yet viewed; red means completed with an error outside the visible session and not yet viewed.
- Extension-originated failures are investigated and recorded before adaptation. inspire will not add retries, suppression, or broad fallback behavior merely to conceal an extension conflict; material adaptation or disabling the extension remains a human product decision.
- The unreviewed enhancement-proposal list is explicitly outside this stage.

## Handoff

The three corrective objectives are complete. A final Kimi K3 frontend review verified the concurrent-status, grouping, settings, and ANSI behaviors and identified one blocker: selecting a session while Settings remained visible cleared its attention without showing the transcript. Session and new-session navigation now leave Settings before opening the conversation, with a regression test. At closure, unrelated Escape-key and backlog edits were preserved.
