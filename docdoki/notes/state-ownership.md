# State and operation ownership

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
