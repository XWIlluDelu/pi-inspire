---
purpose: "Every event socket and asynchronous browser completion remains bound to its session, view, and transport generation across reconnect and concurrent navigation."
covers:
  - server/app.ts
  - server/runtime-event-sockets.ts
  - server/runtime.ts
  - server/pending-operation-receipts.ts
  - src/controllers/pending-recovery-controller.ts
  - tests/server/app-pending-recovery.test.ts
  - tests/integration/pending-{recovery-lifecycle,stop-native.integration}.test.ts
  - server/runtime-worker-pool.ts
  - shared/{contracts,assistant-stream,tool-argument-updates}.ts
  - server/{tool-argument-stream,tool-argument-batches,runtime-stream-budget}.ts
  - src/{api,events,store,snapshot-transition,transport-performance,recovery-backoff}.ts
  - src/controllers/{connection,session-selection,runtime-event,transcript-data}-controller.ts
  - tests/server/{app-events,app-prompt-delivery,runtime-worker-pool}.test.ts
  - tests/browser/native-pi-continuity.spec.ts
  - tests/integration/session-detail-confirmation.test.ts
  - tests/web/{events,store,store-transcript,store-navigation,store-async-ownership}.test.ts
---

# Session transport and browser ownership

## Goal

Reconstruct one current browser projection from Pi without unbounded transport queues or stale
writebacks. This is the transport part of [[session-continuity]], not a second conversation store.

## Per-browser detail

Each authenticated event connection owns one explicit session-detail interest, or none. Changing
interest fences detail behind a fresh addressed snapshot and subscription revision, including during
initial handshakes and reconnects. Another browser's Host selection cannot retarget the connection.
Other sessions send changed compact status/lifecycle outcomes and an attention indicator for
extension interaction, not message, tool, queue or dialog bodies. Filter those bodies before encoding;
retain bounded joining backlogs and event-batch order for interested clients.

A detail subscription retains its view before reading the initial snapshot. Observed views/workers
are exempt from idle reclamation regardless of Host selection. Browsers retain independently;
switching interest, disconnecting or closing the Host releases only that subscription. Retention
neither changes shared selection nor eagerly starts an ordinary worker; external read-only recovery
follows [[session-persistence]]. It does not prevent explicit deletion. Host-restart recovery must
restore history and input without a page refresh or repeatedly reclaiming/rebuilding the visible
conversation when dependent reads fail.

Foreground and navigation state use the Host's explicit `sessionStatus`. Infer transitions from
event names only for unannotated events; failed messages and settlement must not briefly appear
running/idle while awaiting a correcting snapshot. Bounded Host-owned retry details accompany
addressed snapshots and live events and retire outside retry phases. Missing/malformed details
neither hide valid `retrying` state nor invent attempt counts.

## Snapshot synchronization and reconnect

### Authority and unchanged confirmation

Bootstrap, HTTP session-open responses and the first WebSocket snapshot carry a process-lifetime
Host authority and SHA-256 snapshot digest. Validate and apply both authority and snapshot before
publishing the socket as open. Reconciliation must neither duplicate settled messages nor let a
late snapshot replace newer selection.

After a synchronized socket loss, first attempt bounded WebSocket resume with the last confirmed
digest. A match yields a digest-only unchanged acknowledgement; otherwise send a full authoritative
snapshot. Failed resume falls back to bootstrap. A committed HTTP-open snapshot also passes its
authority-bound digest into changed detail interest. The Host still performs a second authoritative
read and queues events behind it, using a digest-only confirmation for an identical window.

Pending detail confirmation retains the exact authority/session/revision/digest witness. Previously
sent detail from another session may invalidate the general reconnect cache, but not this witness.
Current-target or unscoped runtime changes invalidate it. An unchanged reply must match its scope
and digest.

### Recovery triggers and deadlines

Missing first snapshots, application-frame inactivity, failed ping/pong, stale visibility return,
online transitions and BFCache restoration replace the transport through the same resume/bootstrap
boundary. Heartbeats cannot overtake a joining snapshot. Attempts use bounded deadlines and backoff:

- WebSocket establishment: 10 seconds.
- First authoritative snapshot after open: a separate 45 seconds, allowing Pi's 30-second read budget
  plus transfer time.
- Initial/addressed bootstrap and changed detail interest: the same 45-second observation budget.
  Missing-detail fallback stays within its original bootstrap deadline.

Heartbeats and stale snapshots do not extend deadlines. Expired sockets cannot apply late frames or
close callbacks to their replacement.

An addressed reconnect to a confirmed-absent session falls back once to bootstrap without detail,
explains the absence and retains Host access. Keep the same owner/deadline and any newer committed
or pending navigation; do not adopt another browser's selection. Authentication failure, ambiguity,
projection corruption and unclassified read errors do not establish deletion.

Initial read-only hydration normally uses the cached catalog. If its pinned source disappeared,
moved or changed identity, refresh the catalog once and revalidate before opening. Ambiguity or
continued change refuses the read. This recovery neither replaces a live owned projection nor
retries a write. A missing open target refreshes the list while keeping the visible conversation.

Background snapshot failures retain confirmed content and retry with bounded backoff under the same
API, transport, selection and branch-view owner. A fresh snapshot or valid unchanged acknowledgement
retires recovery. Superseded reads cannot publish warnings or restart retries. Commands and prompts
are never replayed; persistent synchronization loss follows [[workbench]].

## Selection and asynchronous completions

### Latest-wins ownership

Open/new/deselect responses require the original API, transport generation and explicit selection
owner. A newer open, new-session, deselection, unaddressed selection push, bootstrap or transport
replacement supersedes the previous operation without serializing navigation. Addressed stream
snapshots refresh existing detail interest without retiring a newer HTTP selection. Successful
new-session selection clears the previous opener; stale completion/cleanup cannot clear a newer one.
Every open/new endpoint finishes fallible projection and runtime-metadata reads before committing
selection or identity.

Bootstrap likewise captures API identity and transport generation. Only the current request may
apply state, load launch preferences, create a socket or interpret 401 as pairing failure. A snapshot
already committed by selection/resync supersedes an older bootstrap snapshot and digest, while Host
metadata may still refresh. Launch continuation honors the intent captured before bootstrap began.
If Host selection changes during a snapshot read, retry against the new owner before sending it.

HTTP resync success and failure share these fences, including same-session view replacement and
A → B → A navigation. A current-API 401 remains transport-wide; a replaced API's error is stale.
Obsolete operation completions cannot start a resync that invalidates the current pending read.
Abort error publication and optimistic thinking rollback also require their original selection
generation. Rename/prompt completions remain bound to their originating session and cannot change
another session's title, draft or visible error.

### Selection and commit effects

Entering New explicitly deselects on the Host and browser. Clear conversation-derived status,
resources, attention acknowledgement and Escape targeting. The former idle worker may remain only
as an unselected LRU entry and becomes eligible for deletion; there is no browser-only drafting
identity competing with runtime selection.

Catalog invalidation and observer notification are best-effort post-commit work. Their failure
cannot turn an operation that changed Host/disk state into an apparently uncommitted outcome.
Fork's committed-destination reporting follows [[session-branches]].

Projection conflicts carry a machine-readable kind and opaque incident id. A healthy projection
whose stopped worker observed external change uses persistent yellow recovery attention while still
blocking writes. Incomplete persistence, projection failure and acceptance-unknown outcomes remain
red blocking errors.

## HTTP observation ownership

| Operation | Observation limit |
| --- | --- |
| Ordinary JSON response, including headers and body | 45 seconds |
| New session and one-shot Fork | 120 seconds for startup/publication |
| Native commands, including compaction/export, and branch navigation | Completion-driven; no observation deadline |

Pi hooks, dialogs and long commands may legitimately exceed ordinary limits. Deadlines cancel only
the HTTP observer, never the worker or an admitted write. Execution can finish after observation
expires; report an unconfirmed outcome. Real transport loss still reports typed uncertainty and
explicit cancellation remains available. Resource previews and uploads share this boundary with
transfer budgets in [[resource-preview]] and [[composer]]; uploads also reclaim late handles. Prompt
and terminal receipts retain their own identities.

Superseded open/new/deselect aborts its observer immediately, including when bootstrap replaces it.
Pending-open deduplication lasts only for that observation. Success, failure and cleanup still
require the original selection/API/transport owner; cancelled late replies or 401s cannot change the
current view/authentication. Socket loss alone does not supersede a current HTTP selection, but a
subsequent bootstrap replacement does.

Transport failure cannot establish mutation outcome. Read-only POSTs report read uncertainty.
Creation has no retained receipt: suppress concurrent creates and require explicit confirmation to
inspect the list before creating again after an unconfirmed outcome. This guard survives selection
and transport replacement within the page, but not page reload. Gateway timeouts and lost error
bodies remain uncertain; pre-dispatch cancellation is known not to have created a session and needs
no confirmation. Non-JSON error pages retain HTTP status and edge markers for connection feedback.

## Prompt delivery observations

Each prompt carries a random operation id and process-lifetime Host authority. Bounded Host
fingerprints admit it once: concurrent/near-term duplicates await or return the same result, changed
content under the same id is refused, and replaced-Host identities fail explicitly. Retiring a result
leaves a tombstone that forbids redispatch.

POST observes delivery for at most 20 seconds, then returns a pending receipt. Authenticated GETs
bound to the same identity/authority continue observation without resending payloads. Each browser
observation has a 30-second limit; cancellation/reconnect retires observation, not execution, and
only its current owner may apply the result. Acceptance can exceed those windows.

Same-Host headers identify the respondent, not the result. Refusal requires matched Host authority,
operation id and a retained rejected outcome. Receipt lookup 401/404/500, timeouts, marked-edge errors,
unowned 5xx and unknown/retired outcomes remain uncertain. Unchanged-draft retry reuses the exact
id/payload while authority is unchanged, including after a delivery-mode change. After Host restart,
inspect refreshed history before resending. [[composer]] owns handoff/restoration;
[[state-ownership]] explains the observation/execution distinction.

## Pending handoff observations

Return and Stop bind dequeue results to Host authority, session, action and a random operation id.
Concurrent requests and unresolved-intent retries share that result. Newly observed runs or admitted
queues create new control intents; their actions cannot replay an earlier Stop/Return. Retain older
unclaimed results by id and observe them independently through receipt-only GETs, without dispatching
again or affecting later input.

Reconnect may observe a receipt while its old mutation observer is still pending. Only the current
API/transport owner restores it once into the original draft partition. Recovered images retain
ordinary staging ownership under [[composer]].

A matched authority/operation terminal receipt establishes execution failure or result retirement
and ends that intent; only a later explicit action admits a new id. Plain HTTP 500, mismatched proof
and transport loss stay uncertain and never trigger another mutation. Tombstones forbid reexecution
of failed or retired ids.

Retain at most 2,048 settled results and 32 MiB for 15 minutes. Process-lifetime tombstones prevent
redispatch after retirement; the 65,536-identity limit refuses further admission. Receipts observe
execution rather than forming another queue.

## Transcript views

Each transcript snapshot/page carries an opaque branch-view generation and effective leaf.
`active.transcriptPage` is the snapshot's single row authority; do not duplicate those rows in
`active.messages`. Explicit same-session navigation, worker reset and non-append replacement change
generation; ordinary appends do not. Older-page cursors bind both view and effective-leaf lineage,
and late pages across a branch boundary are aborted/discarded.

Pi system prompts/tool-loadout messages stay in Host canonical state, outside browser rows and live
overlays. Apply this consistently to compaction checkpoints, aggregate agent events, full/incremental
and reopened/branch views, History search, complete-entry preview and image access. Preserve SDK
entry identities and chronological compaction summaries; system placeholders produce no empty search
results. Filtering changes neither persisted bytes nor ownership claims. Use the ordinary
structured-key redaction policy without an extra text-redaction rule.

## Bounded streaming

### Ordered batches and recovery

Established sockets receive ordered coalesced assistant deltas. Clients joining behind snapshot
synchronization receive complete idempotent replacements. Flush same-message Host batches after
16 ms or before lifecycle/identity boundaries. Browser visual commits adapt from 16 to 50 ms as
text/argument previews grow. Coalesce adjacent updates to one tool while preserving `sourceEventCount`
and its original revision span, including through render-window batching and the 2,048-source-event
ceiling. Invalid identity, reconstructed length, serialization or size state requires an authoritative
snapshot rather than guessing across a gap.

Browser-only bounded Performance timeline measures expose bootstrap/prompt confirmation, WebSocket
handshake phase, snapshot characters and event-window frame/character rates, without persistent
telemetry.

### Overlay and tool output budgets

Trusted text/thinking and tool-argument appends account for JSON bytes, preview metadata and revision
growth without serializing cumulative messages. Enforce escaping, UTF-8, split-surrogate handling,
per-string/item caps and the total overlay budget. Structural changes, completed messages and
snapshots retain full projection validation. When a limit reduces or omits an item, send that bounded
replacement, not an old argument patch against the browser's larger tree.

Live execution carries one Host-authored `outputPreview`, computed before general projection from
the cumulative result: at most 16,000 characters and 400 tail lines. Reconnect uses the same preview;
do not duplicate `partialResult.content`. Retain projected details and child-call metadata, and use
the ordinary transcript representation for completed results.

### Tool argument previews

Each active tool's Host-only parser consumes public Pi argument JSON once, emits immutable path-based
display updates and retains no cumulative raw JSON. Apply ordinary keyed redaction, including escaped
keys and nested secret containers, before fragments can leak values. Raw fragments and unbounded
final ToolCalls cannot bypass projection. `toolcall_end` sends one bounded complete assistant
replacement rather than duplicating the raw call in a delta.

Per preview, allow 32,000 decoded string characters, 256 nodes, eight path segments, 256-character keys
and 256,000 inspected source characters, with separately bounded primitive tokens. A limit or malformed
partial source freezes the readable prefix with a truncation indication; later fragments send no
repeated updates. These limits govern presentation, not execution or file size. Completed calls and
`message_end` retain Pi ownership and ordinary transcript bounds.

Parser ownership belongs to the worker/current assistant message, survives interleaved extension
messages and peer calls, and retires on call/message completion or worker replacement. Reconnect
carries the bounded typed call, preview and stream revision, not parser state. Updates continue against
that identity without reparsing old JSON or recreating the card. Older public Pi starts without
identity/name publish only the completed call.

## Checks

- `session-detail-confirmation.test.ts` combines HTTP/WebSocket synchronization and browser routing,
  including invalid acknowledgements. `app-events.test.ts` checks unchanged, changed and foreign
  authorities; its stable window over 500,000 characters uses under 2,000 bytes of synchronization
  and queued lifecycle frames.
