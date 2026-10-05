# State and operation ownership

## Asynchronous selection ownership

### Request ownership and result authority differ

A request can still own its loading marker after its result has become stale. `BranchController`
clears a still-owned marker when the effective leaf changes, but does not publish the stale History
result. Invalidated requests cannot clear a newer request's marker. Conflating those checks formerly
left History permanently busy after an ordinary append.

Selection identity includes its generation, not only the session ID. A → B → A is a new owner:
late thinking rollback, abort errors and model-change refreshes from the first A cannot publish into
the second. `AppStore.resync` rejects an obsolete owner before allocating a request, so an old A
completion cannot invalidate a valid B refresh.

Bootstrap has a related publication boundary. An open/create/deselect or same-session resync can
commit while reconnect is pending. Metadata may still refresh, but the old snapshot and its digest
cannot attest the retained view. Launch continuation uses the intent captured before bootstrap.

Source and regression evidence: `src/store.ts`, `src/controllers/branch-controller.ts`,
`tests/web/store-async-ownership.test.ts` and `tests/web/branch-store.test.ts`. The regressions cover stale-result and loading-marker ownership.

### Addressed operations are not global selection

A browser can view A while another browser selects B. An addressed snapshot of A must not require a
Host-global selection change. Fork likewise validates the addressed source and fresh branch revision;
its persistence and publication checks remain independent of global selection. The decided contract
is [[session-branches]].

Capture automatic-selection intent before entering the source operation lane. Capturing it after a
queued reconciliation can overwrite a newer selection made while the operation waited. Warm the
attached destination independently of global selection, as ordinary open does, so its addressed
preview receives runtime metadata and does not become eligible for dormant reclamation.

`tests/server/runtime-branching.test.ts` covers another/no global selection, a newer selection during
queued Fork and retained source validation.

### Inspect the public boundary before adding recovery

`RuntimeController.snapshot` reconstructs an absent or reclaimed slot through the catalog and
`prepareSlot`, without selecting it or starting a worker. Inspecting only the lower-level read
delegate once suggested a nonexistent reconnect gap. No additional browser reopen fallback was
needed. The distinction also applies to model discovery: [[state-ownership]].

## Operation lifecycle ownership

### Principle

The execution owner decides whether work was accepted, completed, or stopped. A caller's deadline
ends its observation, not the operation. Retry and restart decisions require the current operation
identity or lease. Contracts: [[composer]], [[pi-integration]], [[session-branches]], [[terminal]],
and [[host-lifecycle]].

### Pi and prompt observation

`server/pi-rpc.ts` leaves Pi-owned mutations unbounded: preflight, compaction, export, and branch
hooks may wait for Pi or a user. Read-only RPCs default to 30 seconds. A timed-out observer retains
its exact id/command for a late response; the 256-request admission budget includes those retired
identities. A protocol or stream failure instead retires the worker.

`server/app.ts` admits a prompt once and returns a pending receipt after 20 seconds. `src/api.ts`
observes the same Host/operation through authenticated GET, with 30 seconds per HTTP observation.
Neither reconnect nor result retirement replays the payload; retired results leave identity
tombstones.

A definitive retained-operation refusal requires matching `X-Inspire-Authority`,
`X-Inspire-Prompt-Operation`, and rejected `X-Inspire-Prompt-Outcome` headers. Authentication,
middleware, and lookup failures lack that evidence, so the browser keeps the original delivery
identity. Confirmed Pi acceptance also survives consumed-upload cleanup failure.

Runtime keeps preflight input queued until Pi lifecycle evidence or an owned idle-state read settles
it, including hooks that finish without starting an agent. Stop can bypass the persistence FIFO to
retire a worker blocked in preflight; the interrupted prompt remains acceptance-unknown. The private
branch handler's RPC completion fences its matching result, so a missing result fails at completion.

Standalone manual compact retains a worker-owned raw-command settlement promise and Pi's terminal
`compaction_end.aborted` evidence. Stop recovers Pending before generic `abort`, then allows three
seconds for cooperative settlement; the grace bounds explicit cancellation, not normal execution.
A cancellation event can accompany a rejected compact RPC with an arbitrary hook diagnostic, so
classification uses the event rather than error-message matching. Unresponsive hooks fall back to
confirmed retirement, and neither a pending nor rejected stop releases the writer fence or permits a
cancelled receipt. Persisted completion racing Stop remains completed even if a post-compact hook
appends native custom state before suspending. `SessionProjection.entriesAfter` identifies new durable
entries beyond the admitted tail; ancestry is validated separately against the admitted effective
leaf. This distinction matters after earlier-branch navigation: the old durable branch can already
contain a checkpoint, and a new one need not descend from its final tail.

### Worker retirement

`PiRpcProcess` shares one stop attempt across callers. The direct helper in `server/pi-rpc-stop.ts`
waits for leader exit or proven spawn failure, plus completion of process-tree signaling. Herdr
also verifies the worker scope is empty, including independently grouped Bash processes
([[herdr-enhancement]]).

`RuntimeWorkerLifecycle.stop` removes the worker from service synchronously and retains
`slot.stopping` until confirmed retirement. Pending or rejected termination blocks replacement and
recovery writes. Signals and watchdogs cannot release that barrier. Completed startup cleanup uses
the same barrier; [[platform-compatibility]] explains the stale-startup-state repair.

A protocol-write failure notifies Runtime on either stop outcome. `stopForProtocolFailure` handles
both outcomes on its notification branch while returning the original stop promise. Handling only
success left a detached rejection that could terminate the Host even when the caller handled both
the request error and the stop error.

### Terminal mutations

`server/terminal-operation-receipts.ts` owns immutable mutation identities across IPC correlation
IDs. Same-intent retries join work or return its result; parameter changes are refused. Bounded
retention uses admission epochs to reject forgotten identities. A replacement daemon has a new
epoch, so the client must resolve uncertainty rather than replay an old mutation there.

The browser saves unresolved identities in tab-session storage before dispatch and retains them
across project changes and reload. Invalid stored intent blocks dispatch. Identified requests use
the receipt protocol; legacy HTTP callers without identities still create one intent per request.
The in-process terminal manager uses the same receipt and mutation implementation. Read,
attachment, and input streams remain separate from control-mutation receipts.

Private daemon protocol **2** supplies these receipts. An existing version-1 daemon stays running
with its PTYs, but is unavailable to the new Host. Upgrading it requires an explicit terminal-service
restart after finishing terminal work. `terminal-daemon-launcher.test.ts` checks that a failed probe
leaves the existing daemon alone.

Unconfirmed operations appear in a bounded recovery list. Recheck disables only its own button.
Late xterm readiness, font, replay, or writer-state callbacks cannot take focus from recovery;
`terminal-focus.ts` permits one guarded focus frame for explicit or neutral activation. Take control
remains a separate user gesture.

### Maintenance restart

`RuntimeController.reserveMaintenanceRestart` grants an expiring preparation lease;
`commitMaintenanceRestart` consumes that exact, current lease and keeps admission closed without
expiry. `deploy/systemd/idle-maintenance-restart.mjs` inspects systemd before committing, then issues
one restart. `MaintenanceRestartController` limits scheduled preparation to changed installed
identities and idle work.

Release belongs to the lease owner and invalidates reordered commits. It is safe before issuance
or after a proven failure to spawn systemctl. An ambiguous submitted command keeps the drain.
Operator recovery must first establish that neither the old runner nor a submitted systemd job can
still restart the Host.

### Regression coverage

| Area | Evidence |
| --- | --- |
| RPC and retirement | `tests/server/pi-rpc-ownership.test.ts`: long waits, late responses, bounded admission, stream validation, shared stop fencing, delayed signaling, failed spawn, and rejected-stop notification. |
| Runtime ownership | `tests/server/runtime.test.ts`: preflight cancellation, branch results, failed-stop fencing, idle hook settlement, and accepted input after cleanup failure. |
| Prompt observation | `tests/{server/app,web/api,web/composer-controller}.test.ts`: one dispatch, retained identities, disconnected observers, and observation errors versus operation refusal. |
| Terminal identity | `tests/{server,web}/terminal-operations.test.ts`, `terminal-inprocess-operations.test.ts`, and `terminal-operation-restore.test.ts`: lost replies, concurrent retries, payload/epoch checks, and stored-intent validation. |
| Restart leases | `tests/server/maintenance-restart.test.ts`, `tests/deploy/idle-maintenance-restart.test.mjs`, and `tests/launcher.test.ts`: expiry, exclusive commit, reordered release, non-issuance, and uncertain submission. |

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

### Unchanged read reuse

Ordinary snapshots, history pages, and resource reads no longer force a full byte scan when
`lstat` still identifies the same healthy, verified regular-file version. Changed or unhealthy
sources take the existing verification path; startup and writer admission still force verification.
This reuses an unchanged observation, not an unverified external append or a metadata-only rewrite.

`tests/server/session-projection-read-reuse.test.ts` checks zero content opens for unchanged reads,
explicit forced validation, same-size rewrites, rewritten-prefix appends, atomic replacement,
symlink substitution, and recovery from a transient read failure. Runtime read tests retain lazy
resource slot/view/revision fencing.

The reproducible `npm run benchmark:projection` uses a synthetic 16 MiB JSONL, three warmups,
and nine alternating samples per mode. On the local Linux/Node 26 run, median reconciliation time
was **7.426 ms forced versus 0.028 ms version-checked**. This measures only unchanged-file
reconciliation, not first parsing, changed files, page serialization, or end-to-end browser latency.

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

## Model discovery ownership

### One response owns a preview

Model choices and native startup defaults describe the same prospective workspace. Independent
requests can finish in a different order: a late default response can overwrite a newer refreshed
model and thinking level even when neither request is individually malformed.

`Welcome` consumes both from one catalog response and uses one request generation to retire older
responses. Query identity follows the target cwd and catalog source, not every live snapshot's model
object or manual thinking change. Explicit choice, source inheritance and manual effort retain their
own selection authority; discovery does not overwrite them.

`tests/web/welcome-new-session.test.tsx` covers a delayed initial read followed by refresh, repeated
same-model snapshots, manual effort and pending-source inheritance. [[model-settings]] and
[[composer]] hold the current contracts.

### Save invalidation precedes readback

A successful configuration save changes the inputs to workspace discovery. Waiting for the active
worker's readback before invalidation leaves older cached or in-flight reads able to publish obsolete
inventory. Invalidate at the successful save boundary; the catalog generation prevents an older
completion from repopulating the cache. Readback still observes the active worker's registrations.

Implementation: `server/model-settings-routes.ts` and `server/model-metadata.ts`. The in-flight/save
regression is in `tests/server/model-settings.test.ts`.

### Inventory readiness is not transcript readiness

Extension discovery can be slow or fail while a session file remains readable. Initial transcript
opening and bootstrap do not await it. Resolve only the addressed source in the background, and keep
unresolved selection distinct from an empty virtual registry: physical reply identity cannot stand
in for a selected Router. New waits for pending source selection rather than substituting workspace
defaults.

## Resource and terminal addressing

### A resource read belongs to its addressed session

Global Host selection is not permission to resolve another browser's resource. `RuntimeReadController`
uses the requested open slot; context reconciliation and lazy message reads retain slot-registration,
view and revision checks without selecting it globally. This is the same ownership distinction as
[[state-ownership]].

Discovery and read authorization are separate. The former Git preview-index and ignore-rule expiry
policy was superseded by [[workbench-implementation]]: discovery may be cached, but content reads
check current workspace containment and the pinned object directly. [[resource-preview]] is the
current contract.

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
