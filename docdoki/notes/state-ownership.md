# State and operation ownership

## State and observation authority

### The abstraction error

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

### Confirmed repairs

1. **Compaction progress followed `/compact` receipts.** `ActivityBar` now renders `Compacting context` directly from `runState`. `CommandActivity` no longer projects running `/compact` receipts; it retains outcomes. The Composer still guards pending requests separately, keeps the existing cancel control, and labels its meter as occupancy rather than compaction progress. Automatic failure/cancellation notices are visible; successful summaries remain in Pi history.
2. **Retry text required a witnessed start event.** `AppStore.applySnapshot` previously cleared `retry` even when the snapshot said `retrying`. The runtime now retains bounded `RetryInfo`, supplies it in addressed snapshots, and retires it outside retrying. `ActivityBar` always shows the phase; valid details add counts/reason, absent detail shows only `Retrying`. `parseRetryInfo` rejects invalid counters and limits the message to 4,000 characters. No new Pi protocol or capability probe is used.
3. **Update-check HTTP failure ended Host execution in the UI.** The controller previously unconditionally set the shared checking flag false in its rejection callback. A targeted test reproduced loss of a newer Host `checking:true` broadcast. Request-pending flags are now independent; a failed/retired request clears only its own flag, while revisioned Host observations continue to own checking. Same-revision snapshots cannot drop duplicate-request guards.
4. **Event-name inference overrode explicit Host state.** The event reducer left `message_end` as running and inferred idle on `agent_settled`, even with a `sessionStatus: failed` envelope. Three targeted tests reproduced incorrect running/idle before correction. The shared reducer now adopts the explicit Host status after reducing event detail, so foreground state agrees with the navigation status without waiting for resync. Unannotated events retain their existing fallback transitions.

Relevant code: `src/components/{ActivityBar,CommandActivity,Composer,Settings}.tsx`, `src/{events,store,app-state}.ts`, `src/controllers/update-controller.ts`, `shared/contracts.ts`, and `server/{runtime,runtime-slot,runtime-events}.ts`. Contracts: [[composer]], [[session-transport]], [[interface-preferences]], [[workspace-layout]].

### Other reviewed boundaries

- **Pending:** `server/runtime.ts` clear-queue handling and browser Pending state use queue updates/snapshots for membership. A clear request is a local guard/receipt, not a second queue authority.
- **Terminals:** `TerminalView` takes writable/readiness from daemon `attached`, `ownership`, `replay_complete`, and `exit`; the replay parser barrier is intentional. Catalog mutations are generation-owned and full catalogs reconcile membership. Local create/restart request guards are not claims that the PTY has started/exited.
- **Connectivity:** `ConnectionController` does not publish connected merely because WebSocket opened; it validates the addressed snapshot/authority first. Transport readiness genuinely belongs to that browser connection.
- **Branches/resources/Git:** request generation, branch view, and transport fence loading/error/result writebacks. Selection is not inferred from a clicked row after ownership changed. Git re-observes actual repository state on scheduled/explicit invalidation instead of treating tool completion as proof of a particular file change.
- **Preferences and Pi settings:** optimistic writes are explicit local intent, with field/selection/transport guards and authoritative reconciliation. They are not categorically wrong because they use callbacks or local flags.
- **Transcript/tool/error presentation:** active lifecycle identity and bounded Pi projection, rather than local send receipts, drive message/card ownership. Failed assistant rows remain message-owned and reconstruct from Pi history.
- **Completion attention:** deliberately depends on an observed live transition and clears arms on transport loss. Replaying historical completion notifications on every snapshot would be a regression, not a repair of this class.

These are bounded ownership-path inspections, supported where applicable by the existing suite; they do not establish that every project path is defect-free or constitute a security/performance audit.

## Resource and terminal addressing

### A resource read belongs to its addressed session

Global Host selection is not permission to resolve another browser's resource. `RuntimeReadController`
uses the requested open slot; context reconciliation and lazy message reads retain slot-registration,
view and revision checks without selecting it globally.

Content requests currently share the project-index discovery cache and in-flight scans.
Branch, canonical-path and pinned-object checks still belong to each addressed read; a
missing served file invalidates discovery. Current contract: [[resource-preview]].

### Partial terminal receipts are not complete catalogs

`TerminalCatalogController` belongs to one project/reload generation. Full reads and mutation
receipts share project, epoch and revision ownership. A partial receipt advances the revision
high-water mark, not complete membership: an equal-revision full response still reconciles order
and membership. An epoch change requires a full catalog; replaced epochs cannot return.

Obsolete success, failure and finally callbacks cannot change current selection, errors or loading
state. Optimistic rollback restores only its exact unchanged state. `tests/web/terminal-pane.test.tsx`
uses delayed APIs for A → B → A, reload, stale polling, partial receipts and equal-revision full
reconciliation; terminal rendering is stubbed for these ordering cases. Contract: [[terminal]].

### File URL conversion is platform-specific

A Windows drive URI retains an extra leading slash if its URL pathname is treated as a filesystem
path. Convert through a file URL and Node's native URL-to-path conversion instead. The Windows-path
suite exercises the parser with Node's Windows algorithms on Linux; it establishes parsing, not
native Windows filesystem or PTY behavior.

Sources: `server/runtime-reads.ts`, `src/terminal-catalog.ts`,
`tests/server/resources-windows-paths.test.ts` and `tests/server/resources.test.ts`.

## Responsibility-focused simplification

### Remove a layer when it adds no owner

The former stateless `RuntimePendingController` forwarded one operation through callbacks while
`RuntimeController` already owned mutation, writer admission and acceptance-unknown handling. Removing
that facade simplified the dependency path without moving authority. Likewise, independent Fork
creates a destination rather than transferring the source worker or dialogs, so fork-era `rebind`
helpers had no remaining role.

This is a reason to inspect responsibility, not a rule against controllers: event sockets and
terminal gateways each own an independent transport lifecycle and justify their modules.

### Split by responsibility, not line count

`server/runtime-event-sockets.ts` owns event interests, snapshots, batching and subscription cleanup;
`server/terminal-gateway.ts` owns terminal routes, tickets and socket attachments. Authentication and
Host shutdown remain in `app.ts`. Neither extracted module owns another transcript, runtime or PTY
registry.

The original 108 store tests were divided by their existing concerns—connection/events, transcript,
navigation, resources, composer/commands and deletion—with only setup shared. Partitioning by those
boundaries preserves discoverability without creating a large generalized fixture layer.

Persistence and incremental projection invariants can cross methods. A large runtime/projection
file therefore needs an identified responsibility boundary, not a mechanical size-based split.

### Keep contracts and experiments in their own homes

Root specs link to detailed contracts by authority: persistence/transport/branches/deletion,
Host lifecycle, workspace/preferences, and activity presentation. A short overview is navigation,
not a duplicate implementation or check ledger.

The retired performance evaluator had drifted into another fake protocol implementation and its
source-string verifier no longer matched the renderer. [[performance]] retains measurements
and exact reproduction points; maintaining obsolete executable fixtures was not necessary to keep
that knowledge.

### StrictMode can recapture a dialog's internal focus

Layout-effect replay can capture an already-focused internal Close button as the restoration target.
On unmount, focus then falls to the document body rather than the outside opener. `useModalFocus`
retains the previous entry's outside opener when replaying the same dialog with focus still inside.
The existing modal stack and stale-microtask ownership remain intact.

An isolated regression failed before the correction; the three affected browser flows then restored
the opener. Source: `src/use-modal-focus.ts` and `tests/web/modal-focus.test.tsx`.
