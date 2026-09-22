# State and operation ownership

## Asynchronous ownership review

### Scope

The ownership review examined session selection,
bootstrap/reconnect, transcript reads, runtime controls, History requests,
composer/resource/Git ownership, Host projection reconciliation and worker
reclamation, and terminal transport. It authorized demonstrated correctness and
implementation-quality repairs, not unapproved product-design changes.

### Reproduced and repaired

The first ten added cases failed against the starting implementation. Thirteen
new regression cases now cover the repaired boundaries and their related cases:

- **Late bootstrap replaced a newer committed snapshot.** Completing open,
  create, or deselect while reconnect bootstrap waited caused the old bootstrap
  selection to win; a same-session resync could also be overwritten. `AppStore`
  now fences the snapshot portion by the snapshot publication generation.
  Current Host metadata can still refresh, but an obsolete snapshot digest cannot
  attest the retained view. Launch continuation uses the intent captured before
  bootstrap, not an intent captured after it returns.
- **History remained permanently busy after ordinary append.** A changed
  effective leaf invalidated a tree/action result without advancing its request
  id; the old completion also refused to clear its loading/action marker.
  `BranchController` now separates ownership of the request marker from authority
  to publish its result. A still-owned request retires its marker and exposes a
  refreshable stale-history state; invalidated requests cannot clear newer work.
- **An old model change suppressed a current session refresh.** After selecting B,
  a completed model request from A started a new A resync and advanced the shared
  request counter. B's already-running refresh then discarded its valid result.
  Model changes capture their original selection generation, and `resync` rejects
  obsolete owners before allocating a request or issuing HTTP.
- **Thinking-level refusal rolled back a reopened selection.** A delayed failure
  from before A → B → A restored the old optimistic predecessor into the reopened
  A. Rollback now also requires the captured selection generation.
- **An old abort error appeared in the current view.** A delayed abort failure
  could replace B's error, or the error of a reopened A or a new same-session
  branch. Visible errors now require the captured selection owner; session-owned
  command activity remains attributable to its original operation.

Current-API authentication failures retain their transport-wide meaning. The
repairs neither cancel accepted Host operations nor add replay/retry fallbacks.
Implementation: `src/store.ts` and `src/controllers/branch-controller.ts`.
Regression evidence: `tests/web/store-async-ownership.test.ts` and
`tests/web/branch-store.test.ts`.

### Approved follow-up — session-addressed Fork

The reviewed implementation required `RuntimeController.selectedSessionId === source.id`
inside `forkBranchInside`, while event subscriptions and snapshots were addressed
per browser. An isolated runtime probe reproduced this sequence:

1. Open A, then open B as a second browser would.
2. An addressed snapshot of A succeeds without changing the Host selection.
3. Fork A refuses with `Fork requires the source session to remain selected`.

The user approved replacing this admission policy with session-addressed Fork.
`forkBranchInside` now validates the addressed source and its fresh branch
revision, retaining source identity, conflict, active-path user target,
committed-prefix, and publication checks. The contract is in [[session-branches]].

Two related lifecycle details matter:

- Capture the automatic-selection fence before entering the source operation
  lane. Capturing it only after reconciliation lets a queued fork overwrite a
  newer selection made while it waited.
- Warm the attached destination independently of global selection, as ordinary
  `openSession` does. The requesting browser can adopt that addressed preview
  even while another session remains globally selected; skipping warm-up leaves
  the destination without runtime metadata and eligible for dormant reclamation.

Four added runtime regression cases failed before this repair. They cover a
source viewed while another session or no session is globally selected, newer
selection during a queued fork, and retained source validation. The expanded
active-source test also checks unchanged source bytes, worker/queue/dialog
continuity, destination readiness, and no unexpected global selection change.

### Rejected reconnect hypothesis

The initial runtime probe also disproved a suspected reconnect gap: `RuntimeController.snapshot`
already reconstructs an absent or LRU-reclaimed slot through the catalog and
`prepareSlot`, without changing global selection or starting a worker. Reading
only its lower-level `RuntimeReadController` delegate misses that boundary. No
extra browser reopen fallback was retained.

## Operation lifecycle ownership

### Principle

A layer's inability to observe work does not prove what the owner did. In particular:

- No timely receipt does not mean no execution or a dead worker.
- An HTTP refusal can reject the observation rather than the original operation.
- A stop signal, escalation deadline, or expired wait does not confirm process exit.
- Once-valid permission does not authorize a later action after ownership changes.

The corresponding decisions belong to the execution owner and its operation identity, not a
transport timer, command spelling, callback completion, or stale lease. This extends
[[state-ownership]] from presentation to decisions that can stop, duplicate, or interrupt
work. Contracts are in [[composer]], [[pi-integration]], [[session-branches]], [[terminal]], and
[[host-lifecycle]].

### Repairs

#### Pi and prompt observation

`server/pi-rpc.ts` no longer gives Pi-owned mutations a generic completion deadline. Prompt
preflight can include auto-compaction, input/before-agent hooks, and extension interaction;
standalone compaction, export, and branch hooks can also legitimately take time. Read-only RPCs
retain a bounded observation deadline. Timed-out observers leave exact id/command tombstones for
late responses; the bounded 256-request admission budget includes those tombstones instead of
evicting them. Protocol/stream failure remains distinct and does retire a worker.

`server/app.ts` admits a prompt once and returns a pending receipt after its 20-second HTTP
observation window. `src/api.ts` re-observes that same Host/operation by authenticated GET, with a
30-second limit per HTTP observation and no replayed text/attachments. Transport retirement only
aborts observation. Host result retirement leaves an identity tombstone, not permission to run again.

Only a matching `X-Inspire-Authority`, `X-Inspire-Prompt-Operation`, and rejected
`X-Inspire-Prompt-Outcome` identify a retained operation's definitive refusal. Auth, middleware,
missing/retired lookup, and other observation errors do not acquire that proof. Explicit unknown
outcomes retain the draft's ID even when authored by the same Host. Confirmed Pi acceptance also
survives failure of best-effort consumed-upload cleanup.

`server/runtime.ts` keeps a preflight prompt queued until actual lifecycle evidence arrives and
retires that queued state when a non-agent extension command completes. Stop during preflight
bypasses the persistence FIFO and can stop its owning worker even if Pi's ordinary abort cannot
interrupt a waiting hook. Such interruption remains acceptance-unknown. Private branch-handler RPC
completion fences its matching result, so missing results fail immediately after completion rather
than requiring an arbitrary branch timer. Diagnostic phases are coarse metadata, not payloads or
execution authority.

#### Confirmed worker retirement

`server/pi-rpc-stop.ts` owns one shared termination promise. It requires observed leader exit (or
proven failure to spawn) and completed process-tree signaling before resolving. Slow signaling,
escalation, and watchdog expiry do not fabricate `worker_stopped`. `server/runtime-worker-lifecycle.ts`
retains even a rejected stop barrier, so replacement and recovery cannot acquire a writer before
termination is established. Concurrent Stop calls join the same retirement.

#### Terminal mutation identity

`server/terminal-operation-receipts.ts` records mutations at the execution owner; the private daemon
protocol carries the same immutable identity independently of each IPC correlation ID. Same-intent
retries join in-flight work or return the recorded result. Parameter mismatch is refused. Response
retention is bounded, and admission epochs fence forgotten identities instead of replaying them;
a replacement daemon also has a different epoch. Read, attachment, and input streams remain separate.

The browser controller retains unresolved identities in tab-session storage before dispatch,
including across project changes and reload. Identified requests never silently fall back to
legacy unprotected execution. A query timeout cannot create a second terminal or restart it twice.
Storage/epoch/result uncertainty stays explicit rather than silently manufacturing a new intent.
Legacy HTTP callers without identities retain one-new-intent-per-request behavior; no new guarantee
is claimed for those callers. The in-process TerminalSessionManager uses the same owner-lifetime
receipt implementation and shared mutation dispatch; it never bypasses protection for fixtures.
Malformed stored key/path/method/body/identity relationships fail closed before new dispatch.

The required private protocol is now version 2. An existing version-1 daemon cannot supply these
mutation receipts. Ordinary Host launch leaves a listening incompatible daemon and its PTYs alone,
instead of using the old destructive replacement handshake. Applying terminal changes to such an
installation requires an explicitly authorized terminal-service restart after finishing terminal
work; restarting the Host alone intentionally reports terminal service unavailable. The synthetic
`terminal-daemon-launcher.test.ts` proves failed probe never sends replacement or spawns a daemon.

Unconfirmed controls use an independently bounded, non-overlapping recovery list identifying the
operation/target. Rechecking keeps the uncertainty visible while disabling only that check button;
local waiting never claims the operation is cancelled. Lazy tabs reference only mounted panels.
The rendered desktop regression also exposed readiness-driven xterm autofocus stealing focus from
recovery. `terminal-focus.ts` now gives only explicit/neutral activation one guarded animation frame;
fonts, replay, and writer-state callbacks do not reclaim focus. Explicit Take control remains a
local gesture, separate from actual input ownership.

#### Maintenance restart authority

`server/maintenance-restart.ts` separates expiring prepare from committed drain. The runner in
`deploy/systemd/idle-maintenance-restart.mjs` inspects systemd first, then commits the exact owner
lease immediately before dispatch. An expired, released, foreign, or already-consumed lease cannot
authorize a restart. Committed drain cannot auto-expire while a delayed restart could still execute.

Release is owner-bound and invalidates even a reordered commit. It is allowed after failure before
issuance or proven failure to spawn systemctl, not after ambiguous command exit/timeout. Unknown
restart issuance retains drain and reports recovery required. Operator recovery must establish
that neither the old owner nor a submitted systemd job can still restart the Host. This trades
automatic availability for safety; it is not a new background retry loop.

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

## Projection reconciliation ownership

### Finding

Awaiting an old queue tail does not join its transaction. Explicit reconciliations formerly waited
for `RuntimeSlot.projectionTail`, but their read, asynchronous ownership witness, and baseline commit
were not in that FIFO. Another read could replace the projection while the first witness waited,
causing two legitimate appends to be compared against the same old writer baseline.

A separate path treated changed stat metadata with unchanged committed contents as `not-append`.
That is not proof of a content mutation. Raw `stat` fields can also be observed at different points
in a concurrent append; such an experiment alone does not reproduce the reader's complete
before/after validation. The exact filesystem origin of the reported timestamp movement remains
unestablished. Synthetic full-reader tests establish the observation's handling independently of
that origin.

This extends [[state-ownership]]: a file observation, pending verification, and
permission to advance the current writer baseline must remain distinct. The decided contract is
[[session-persistence]].

### Implementation

- `SessionProjection` binds an asynchronous Host reconciliation consumer inside the same FIFO as
  the physical read. Explicit calls, watch/poll hints, and watch-health failures cannot bypass a
  pending ownership check. Hints retain one pending read and a coalesced dirty indication rather
  than accumulating a read for each event. Retired watchers cannot publish new health failures.
- `RuntimeProjectionCoordinator` no longer maintains an independent post-read handler queue.
  `projectionTail` tracks the current consumer for lifecycle draining; the projection's FIFO owns
  read/consume ordering. Diagnostics use the observation's captured byte counts, not a later
  mutable projection. Consumer rejection still reaches the explicit caller and the runtime log.
- Suspended startup reads remain owned by the startup attestor. Ordinary reads recheck suspension
  after waking, and the FIFO drains consumers before the startup boundary proceeds. Startup's
  identity/stat equality requirement is unchanged.
- Post-await worker/projection checks prevent retired witnesses and deferred receipts from
  repopulating baselines, consuming claims, or creating a new conflict after Stop. Claim consumption
  uses matched identities: cancelling an earlier matched claim while a later receipt waits cannot
  remove an unrelated future claim from the queue.
- Empty overlays have an O(1) reconciliation path, avoiding a full persisted-message scan during
  unchanged polling observations.

### Content-equivalent metadata boundary

The reader supplies `verifiedUnchangedContent` only after a stable, full-byte revalidation of the
same object with no old or new incomplete tail. An owned-prefix shortcut cannot supply that proof.
The coordinator additionally requires the exact existing writer baseline, healthy state, and no
conflict or pending partial lease before refreshing the source version.

The `projection_metadata_revalidated` diagnostic records only identities, versions, revision, and
byte counts. This is acceptance of unchanged state, **not** evidence of who changed the timestamps.
It does not consume a persistence expectation, accept a new entry, change the history/view, or
reauthorize a conflicted writer. It is independent of running, compacting, or idle presentation.

A completed in-place write of identical bytes also satisfies this state-equivalence proof. The old
blanket wording that every same-byte rewrite must be rejected was too broad for this boundary;
[[session-persistence]] now explicitly distinguishes it from content changes, object replacement,
and incomplete-tail rewriting. Startup retains its stricter source-version comparison, and the
pre-existing bounded new-file materialization handling is not broadened into a partial-tail lease.

## Resource and terminal ownership review

 follow-up: [[workbench-implementation]] supersedes the preview-index authority and ignore-rule cache tradeoff below. Only discovery is cached; each content read checks current workspace containment and the pinned object directly. The session/terminal ownership repairs remain in force.

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
