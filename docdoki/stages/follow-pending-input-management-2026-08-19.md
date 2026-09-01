---
scope:
  - docdoki/specs/composer.md
  - docdoki/specs/conversation.md
  - docdoki/specs/pi-integration.md
  - package.json
  - package-lock.json
  - shared/contracts.ts
  - server/app.ts
  - server/pi-rpc.ts
  - server/runtime.ts
  - server/runtime-events.ts
  - server/runtime-pending.ts
  - server/runtime-slot.ts
  - src/api.ts
  - src/events.ts
  - src/store.ts
  - src/components/ActivityBar.tsx
  - src/components/Composer.tsx
  - src/components/Transcript.tsx
  - src/components/transcript-rows.tsx
  - src/styles.css
  - tests/server/app.test.ts
  - tests/server/pi-compat.integration.test.ts
  - tests/server/runtime.test.ts
  - tests/shared/pending-contracts.test.ts
  - tests/web/api.test.ts
  - tests/web/events.test.ts
  - tests/web/store.test.ts
  - tests/web/transcript-inspection.test.tsx
  - tests/browser/workbench.spec.ts
---

# Pending input pause and management

## Objective

Turn the existing Pending projection into a small, truthful Session queue manager. A user can pause delivery without interrupting the current Pi run, make a few explicit changes while the queue is stable, and resume it without moving content into a second browser-owned holding system.

## Current state

- INSΠRE implements bounded structured Pending projection and management, but exposes it only when the worker supplies that protocol. Current public Pi 0.84.4 exposes only `queue_update` events with `steering` / `followUp` text arrays plus `pendingMessageCount` in `get_state`, and no structured management RPC, so the installed-Pi compatibility suite witnesses the safe read/copy-only fallback.
- The historical companion-Pi work described below is not present in the current public package, and this project records no reachable source checkout or commit that can serve as its compatibility witness. Structured management is therefore dormant rather than a shipped Pi capability.
- Under a negotiated structured protocol, paused queues pin their Pi worker across settlement, reconnect, navigation, and ordinary idle handling. Worker loss clears the projection and follows the existing visible runtime-failure path.
- The Pending surface provides exact text copy on demand, image/non-text markers, Pause/Resume, and paused-only delete, confirmed clear, and `S` / `Q` conversion. Queue and payload limits bound snapshots, DOM size, and exact-text responses.
- The Composer stop button and global Escape remain the independent raw Pi RPC `abort`; they do not mutate Pending.
- The next release gate is a traceable Pi source revision containing the companion protocol plus a real installed-Pi compatibility test for the structured state and every mutating operation. Until then, only the text-only fallback is accepted.

## Settled product contract

- Pending has Session-scoped **Active** and **Paused** delivery states. Pause atomically suspends every entry that is still unconsumed at Pi's operation boundary; the current Pi run continues unchanged.
- Paused is independent of run state and queue length. It survives natural settlement and an empty list, which remains visible as `Pending paused · 0`, until the user explicitly resumes.
- New Steer and Queue submissions made while paused append to their respective paused queues and do not start or alter a Pi run.
- Resume reactivates all entries. If a run is active, Pi consumes them at the ordinary steering/follow-up boundaries; if the Session is idle, Resume immediately starts their ordinary processing.
- Active Pending remains read/copy only because consumption can race every item-level mutation. Its presentation is intentionally quiet and low-presence so ordinary queued work does not compete with the conversation; Paused Pending becomes more prominent because management is then available. Paused Pending additionally permits deleting one item, confirmed Clear all, and toggling an item between Steer and Queue by activating its `S` / `Q` mark. Conversion appends the item to the target queue's tail.
- The Composer remains the only text editor. There is no inline item editing or reordering: copy, delete, modify in Composer, and submit again is the explicit manual workflow.
- There is no Take back, Held surface, move-to-composer operation, undo store, or browser-owned queue authority.
- Complete structured content remains Pi-owned. Images pause, resume, delete, and convert with their owning item; the browser receives only bounded presentation metadata such as image count. Copy remains a text operation and does not claim to reconstruct images.
- Abort and Escape remain the existing raw Abort operation. They do not implicitly pause, resume, clear, or otherwise mutate Pending.
- The first implementation is intentionally process-lifetime only. Paused state and content survive browser refresh, reconnect, Session navigation, natural settlement, and ordinary idle management; they prevent worker eviction and the all-idle maintenance restart. Explicit Host/Pi restart, process exit, or machine restart does not promise recovery and clears the projection with a visible runtime failure when one is observable.
- Steer and Queue retain their separate FIFO orders. INSΠRE does not invent a cross-kind chronology that Pi does not currently preserve.

## Required Pi boundary

These remain the agreed companion-Pi requirements, but are not accepted until a traceable source revision and installed-Pi witness exist.

- [ ] Add official agent/session queue support that retains complete messages while paused and makes paused entries non-consumable without making the agent continuation loop spin.
- [ ] Give every queued entry stable process-lifetime identity, delivery kind, and bounded presentation metadata; publish one monotonically increasing queue revision and the paused state in snapshots/events.
- [ ] Add atomic RPC operations for pause, resume, delete-by-id, clear-all, and convert-by-id. Each operation validates the expected queue revision and returns the resulting authoritative projection; stale operations fail without partial mutation.
- [ ] Make direct Steer/Queue RPC input pause-aware even while the Session is idle, and make Resume start queued work when no agent run remains.
- [ ] Emit queue changes from the complete agent queue rather than text matching on `message_start`, covering empty text, duplicate text, images, and extension-originated queued content.
- [ ] Preserve existing raw `abort`, queue modes, TUI clear-to-editor behavior, and consumers that use the current text arrays; add capability negotiation rather than changing their established semantics.

## INSΠRE work

- [x] Negotiate compatible structured Pending state from the worker's authoritative state; never simulate pause in the browser or silently fall back to destructive `clearQueue()`.
- [x] Project paused state, revision, stable item IDs, delivery kind, text, and bounded non-text metadata through authenticated snapshots and events.
- [x] Route every queue mutation through the Session mutation gate with process/incarnation and revision validation. Reconcile only from the authoritative operation result/event.
- [x] Keep paused queues across `agent_settled`, protect their worker from eviction and maintenance leases, and clear them on worker replacement/exit with existing visible failure reporting.
- [x] Keep the established Pending visual structure. Keep Active Pending deliberately low-presence, make Paused Pending more prominent when management becomes available, and add a quiet Active/Paused signal, Pause/Resume, paused-only delete and type-toggle controls, confirmed Clear all, and an explicit empty paused state without adding a second editor or reorder UI.
- [x] Keep same-session branch replacement, deletion, and other queue-destructive operations unavailable until Pending is resumed and consumed or explicitly cleared. Independent fork does not consume or replace the source worker, so source Pending remains intact and does not block it.
- [x] Bound queue events and rendering so many large text entries cannot exceed the existing RPC/WebSocket limits or create an unbounded active DOM, without changing copy authority for accepted text.

## Acceptance

The INSΠRE-side fake-driver and browser tests cover these transitions, but end-to-end acceptance remains open until the required Pi boundary is available.

- [ ] Pause wins atomically over only entries Pi has not consumed; a racing consumed entry is never reintroduced or shown as paused.
- [ ] The current agent run proceeds through completion while Pending remains paused, including an empty paused state afterward.
- [ ] New text, duplicate text, image-plus-text, and image-only Steer/Queue input joins the paused queue without starting work.
- [ ] Resume during a run and after settlement both process entries once under Pi's existing queue modes and per-kind FIFO semantics.
- [ ] Delete, Clear all, and `S` / `Q` conversion operate only while paused, preserve complete image content where retained, and reject stale revisions without partial effects.
- [ ] Copy produces the established exact text output and never represents omitted images as copied.
- [ ] Browser reconnect and Session navigation restore the paused empty/non-empty surface; worker eviction and idle maintenance do not remove it.
- [ ] Raw Abort/Escape behavior remains unchanged for Active and Paused queues.
- [ ] Worker loss is visible and never leaves a browser-only paused list that Pi no longer owns.
- [ ] A real installed-Pi suite covers the structured state machine and its image/race boundaries; the current suite covers only the public text-only fallback.
