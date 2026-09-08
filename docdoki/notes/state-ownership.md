# State and operation ownership

## State authority review

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

## Resource and terminal ownership review

### Scope and decisions

The review identified three local defects: resource reads followed global Host selection, terminal mutations could write into another project's pane, and VS Code file URIs retained the URL slash before Windows drive letters. It also identified unconditional preview index rebuilds and the unused terminal `replayModeRef`.

- `RuntimeReadController` now addresses the requested open slot. Context reconciliation and lazy message reads retain slot-registration, view, and revision checks without reading or changing global selection. The mock runtime follows the same addressed contract.
- `TerminalCatalogController` is local to one pane project/reload generation. Full reads and mutation receipts share project, epoch, revision, and ID-merge rules. Partial receipts record a revision high-water mark, not a complete inventory: equal-revision full responses still reconcile membership/order. Epoch changes require a full catalog; previously replaced epochs are rejected. Obsolete success/failure/finally callbacks cannot change selection, errors, creation state, or ordering in the current project. Optimistic rollback only restores its exact unchanged state.
- VS Code paths are converted through a file URL and Node's native URL-to-path conversion, preserving Windows drives and POSIX absolute paths.
- Following the review's proposed tradeoff, content requests reuse the five-second project-index cache and shared in-flight scans. Ignore-rule changes become effective on cache expiry or explicit Files refresh. Per-request branch, realpath, and pinned-object checks remain; a serving-time missing indexed file still invalidates the cache. No measured latency improvement is claimed.
- The write-only replay ref was removed. No broader request framework, terminal protocol change, or test deletion was needed.

Contracts: [[resource-preview]] and [[terminal]].

## Simplification review

### Repairs

- Removed unused fork-era `rebind` methods from `RuntimeProcessRegistry` and
  `RuntimeExtensionUiController`. An independent fork does not transfer the source
  worker or its dialogs; new-session creation finalizes its existing provisional slot.
- Removed the stateless, single-operation `RuntimePendingController`. Queue clear now
  uses `RuntimeController`'s existing mutation, writer-admission, and
  acceptance-unknown handling instead of wiring another callback facade.
- Removed the redundant `/compact` parser. The new-session prompt path remains
  supported, but branches before ordinary attachment leasing and shares native
  command parsing and compaction lifecycle. It is not merely an old-client fallback.
- Hidden-clear preflight now defaults directly to `validateSessionFile`, independently
  of the destructive adapter's function identity. Filesystem-backed tests prove that
  a malformed target rejects the entire reviewed batch before any deletion call,
  even with an injected delivery adapter. See [[session-deletion]].
- Terminal spawn and restore share one metadata shape, emulator initialization, and
  advisory-event registration. A thrown PTY factory disposes the allocated emulator
  and listeners without publishing a terminal or advancing the catalog. Tests retain
  live creation, restart, and restore coverage.
- Removed confirmed unused store/Git/terminal controls, the obsolete ring-buffer
  reset method, an installation-key passthrough, and the navigation component's
  test-only re-exports. Tests import `nav-model` directly.
- Retired the maintenance benchmark's 2,218-line experiment, 78-line bundle-source
  checker, 37-line profiler adapter, package entry points, and four App Profiler
  branches. The experiment had five type errors outside normal typecheck coverage;
  its source-string verifier also failed against the current renderer. Historical
  measurements, method, and exact Git reproduction points remain in
  [[performance]]. No new performance improvement is claimed.

### File boundaries

`server/app.ts` previously combined HTTP authentication/routes with two independent
WebSocket lifecycles. The review reduced it from 2,410 to approximately 1,517 lines:

- `server/runtime-event-sockets.ts` owns `/events` interests, snapshots, bounded
  batching/backpressure, heartbeat state, and subscription cleanup.
- `server/terminal-gateway.ts` owns Terminal HTTP routes, single-use tickets,
  attachments, and terminal-socket cleanup.
- The shared cookie/origin admission and Host shutdown remain in `app.ts`. The new
  modules do not own another runtime registry, transcript, or PTY store.

The 5,085-line `tests/web/store.test.ts` was partitioned by its existing 12 describe
blocks into six suites: connection/events, transcript, navigation, resources,
composer/commands, and deletion. All 108 tests remain unchanged in substance and
pass. The largest resulting suite is about 1,224 lines; only the small setup fixture
is shared. This is a responsibility split, not reduced regression coverage.

The large `RuntimeController` and `SessionProjection` files still warrant care, but
were not split mechanically: their mutation/persistence and incremental projection
invariants cross method boundaries, and they already use bounded collaborators.
This review does not establish that every remaining large file is optimally factored.
Generated font CSS and source-attributed design material were retained because they
serve runtime rendering or preserve human design intent, not because of their size.

### Document boundaries

The prior Markdown specs hid substantial size in single-line bullets: the session,
Pi integration, workbench, and conversation contracts were approximately 28.6, 20.8,
27.4, and 25.9 kB. Their 103 checks were first relocated with exact word/qualifier
preservation, then duplicate startup/fork descriptions were consolidated without
removing their additional constraints.

- [[session-continuity]] now routes to [[session-persistence]],
  [[session-transport]], [[session-branches]], and [[session-deletion]].
- [[pi-integration]] delegates pairing, packaging, services, and build publication
  to [[host-lifecycle]].
- [[workbench]] delegates detailed geometry and preferences to [[workspace-layout]]
  and [[interface-preferences]].
- [[conversation]] delegates fold and Adaptive timing to [[activity-presentation]].
- The coherent [[composer]] contract remains together, but its 15 checks are grouped
  by concern and wrapped into readable paragraphs. Concurrently completed image-layout
  and directory-picker requirements were preserved.

Root contracts and `spec_abstract.md` link directly to the new homes. Stale source/test
associations were removed, moved store tests are addressed by their current paths,
and comments about global selection, fork rebinding, Trash delivery, and update
identity were corrected. Document checks found no unmatched `covers` patterns or
broken wiki-links; the DocDoki private-boundary check passed.

### Focus regression found during verification

Three browser cases initially failed to restore the Settings/image opener. An
isolated StrictMode unit test reproduced the bug before the fix: layout-effect replay
captured the already-focused internal close button as the new restoration target.
Unmount then left focus on the document body.

`useModalFocus` now retains the previous entry's outside opener only when replaying
on the same dialog with focus still inside it. It retains the existing modal-stack,
nested restoration, and stale-microtask guards. The new test went from failing to
passing; the three affected modal suites passed all 11 tests. Production Chromium
subsequently passed both Settings variants and image dismissal/focus restoration.
