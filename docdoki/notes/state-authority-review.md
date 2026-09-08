---
purpose: Distinguish domain state from its trigger/request/observation, with confirmed repairs and review boundaries.
---

# State authority review

## The abstraction error

A trigger, HTTP promise, or observed event is evidence about work, not necessarily the owner of its current state. Treating that evidence as authority makes identical work look different depending on how it started or when a browser joined.

The original compaction implementation organized feedback around making `/compact` execute, report, and cancel. It put running text into a local command receipt while the blue Composer halo already used the authoritative run state. The first proposed patch added a run-state fallback inside CommandActivity and deduplicated it against local receipts. That still left command presentation responsible for runtime state and was replaced, not adopted as the design.

Four concepts must stay distinct:

| Concept | Proper owner | Examples |
|---|---|---|
| Intent / request pending | Initiating UI/request generation | Duplicate-click guards, optimistic preference writes, sending a prompt |
| Current domain state | Runtime/service owning the work | Pi compaction/retry, Host update execution, daemon terminal writer |
| Current detail | Snapshot/live projection of that owner | Retry attempt and bounded reason, Pending membership |
| Outcome / attention | Operation receipt, canonical history, or explicitly observed transition | Export path, `/compact` result, Pi summary/error message, opt-in completion alert |

A reconstruction test: hold the authoritative state fixed, but vary manual/automatic trigger, observer browser, refresh/reconnect, and HTTP completion ordering. Current-state presentation must remain equivalent. Request feedback and completion notifications need not be identical across observers because their ownership is intentionally narrower. Unknown detail should remain unknown rather than becoming a fabricated counter or the absence of a known phase.

## Confirmed repairs

1. **Compaction progress followed `/compact` receipts.** `ActivityBar` now renders `Compacting context` directly from `runState`. `CommandActivity` no longer projects running `/compact` receipts; it retains outcomes. The Composer still guards pending requests separately, keeps the existing cancel control, and labels its meter as occupancy rather than compaction progress. Automatic failure/cancellation notices are visible; successful summaries remain in Pi history.
2. **Retry text required a witnessed start event.** `AppStore.applySnapshot` previously cleared `retry` even when the snapshot said `retrying`. The runtime now retains bounded `RetryInfo`, supplies it in addressed snapshots, and retires it outside retrying. `ActivityBar` always shows the phase; valid details add counts/reason, absent detail shows only `Retrying`. `parseRetryInfo` rejects invalid counters and limits the message to 4,000 characters. No new Pi protocol or capability probe is used.
3. **Update-check HTTP failure ended Host execution in the UI.** The controller previously unconditionally set the shared checking flag false in its rejection callback. A targeted test reproduced loss of a newer Host `checking:true` broadcast. Request-pending flags are now independent; a failed/retired request clears only its own flag, while revisioned Host observations continue to own checking. Same-revision snapshots cannot drop duplicate-request guards.
4. **Event-name inference overrode explicit Host state.** The event reducer left `message_end` as running and inferred idle on `agent_settled`, even with a `sessionStatus: failed` envelope. Three targeted tests reproduced incorrect running/idle before correction. The shared reducer now adopts the explicit Host status after reducing event detail, so foreground state agrees with the navigation status without waiting for resync. Unannotated events retain their existing fallback transitions.

Relevant code: `src/components/{ActivityBar,CommandActivity,Composer,Settings}.tsx`, `src/{events,store,app-state}.ts`, `src/controllers/update-controller.ts`, `shared/contracts.ts`, and `server/{runtime,runtime-slot,runtime-events}.ts`. Contracts: [[composer]], [[session-transport]], [[interface-preferences]], [[workspace-layout]].

## Other reviewed boundaries

- **Pending:** `server/runtime.ts` clear-queue handling and browser Pending state use queue updates/snapshots for membership. A clear request is a local guard/receipt, not a second queue authority.
- **Terminals:** `TerminalView` takes writable/readiness from daemon `attached`, `ownership`, `replay_complete`, and `exit`; the replay parser barrier is intentional. Catalog mutations are generation-owned and full catalogs reconcile membership. Local create/restart request guards are not claims that the PTY has started/exited.
- **Connectivity:** `ConnectionController` does not publish connected merely because WebSocket opened; it validates the addressed snapshot/authority first. Transport readiness genuinely belongs to that browser connection.
- **Branches/resources/Git:** request generation, branch view, and transport fence loading/error/result writebacks. Selection is not inferred from a clicked row after ownership changed. Git re-observes actual repository state on scheduled/explicit invalidation instead of treating tool completion as proof of a particular file change.
- **Preferences and Pi settings:** optimistic writes are explicit local intent, with field/selection/transport guards and authoritative reconciliation. They are not categorically wrong because they use callbacks or local flags.
- **Transcript/tool/error presentation:** active lifecycle identity and bounded Pi projection, rather than local send receipts, drive message/card ownership. Failed assistant rows remain message-owned and reconstruct from Pi history.
- **Completion attention:** deliberately depends on an observed live transition and clears arms on transport loss. Replaying historical completion notifications on every snapshot would be a regression, not a repair of this class.

These are bounded ownership-path inspections, supported where applicable by the existing suite; they do not establish that every project path is defect-free or constitute a security/performance audit.

## Verification

- On Node 22.19.0, the complete Vitest suite passed: **135 files, 1298 tests passed, 3 skipped**. This includes new server retry snapshot/bounding/retirement checks, state-driven UI tests, command/event ordering, background ownership, malformed retry fallback, and the previously failing update/status regressions.
- Typecheck, lint, format, unused-code checks, and the production web build passed.
- Chromium reviewed the production web build through an isolated mock Host. Controlled addressed snapshots demonstrated compaction without a command receipt at 1280×900 light and 375×812 dark/Jade; retry 2/3 with reason was restored through page reload at 375×812. Both narrow activity surfaces had no horizontal overflow. Local screenshots: `output/playwright/compaction-state-{desktop,narrow}.png`, `output/playwright/retry-state-narrow.png`.
- Browser phase injection exercises presentation/reconstruction, not a real provider's threshold compaction or overload. No daily-use Host/Pi process was restarted; no live provider failure was induced. Automatic outcome notices remain transient and do not introduce a durable error/operation history.
