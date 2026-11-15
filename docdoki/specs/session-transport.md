---
purpose: "Every event socket and asynchronous browser completion remains bound to its session, view, and transport generation across reconnect and concurrent navigation."
covers:
  - server/app.ts
  - server/runtime-event-sockets.ts
  - server/runtime.ts
  - server/operation-receipts.ts
  - src/controllers/pending-recovery-controller.ts
  - tests/integration/pending-{recovery-lifecycle,stop-native.integration}.test.ts
  - server/runtime-worker-pool.ts
  - shared/{contracts,host-endpoints,host-operations,json-endpoints,assistant-stream,tool-argument-updates}.ts
  - server/{tool-argument-stream,tool-argument-batches,runtime-stream-budget}.ts
  - src/{api,events,store,snapshot-transition,transport-performance,recovery-backoff,operation-observer,receipt-storage}.ts
  - src/controllers/{connection,session-selection,runtime-event,branch,resource,session-catalog}-controller.ts
  - tests/server/{app-events,app-input-operations,runtime-worker-pool}.test.ts
  - tests/integration/session-detail-join.test.ts
  - tests/web/{events,store,store-transcript,store-navigation,store-async-ownership}.test.ts
---

# Session transport and browser ownership

## Goal

Reconstruct one current browser projection from Pi without unbounded transport queues or stale
writebacks. This is the transport part of [[session-continuity]], not a second conversation store.

## Per-browser detail

Each authenticated event connection owns one explicit session-detail interest, or none. Changing
interest fences detail behind a fresh addressed snapshot and subscription revision, including during
initial handshakes and reconnects. Another browser opening a session cannot retarget the connection.
Other sessions send changed compact status/lifecycle outcomes and an attention indicator for
extension interaction, not message, tool, queue or dialog bodies. Filter those bodies before
encoding; keep bounded joining backlogs and event-batch order for interested clients.

Each browser-bound runtime event has an encoded-size ceiling, and a joining connection has a
bounded pre-snapshot backlog. An established slow client is closed once its outbound buffer crosses
the Host limit; reconnecting obtains a fresh authoritative snapshot instead of retaining unbounded
deltas.

A detail subscription retains its view before reading the initial snapshot. Observed views/workers
are exempt from idle reclamation. Browsers retain independently;
switching interest, disconnecting or closing the Host releases only that subscription. Retention
does not eagerly start an ordinary worker; external read-only recovery
follows [[session-persistence]]. It does not prevent explicit deletion. Host-restart recovery must
restore history and input without a page refresh, and without repeatedly reclaiming/rebuilding the
visible conversation when dependent reads fail.

Foreground and navigation derive run state from one Host status per session. The addressed snapshot
and live events use the same status contract. Message and lifecycle events still update transient content
and request presentation. The browser acknowledges the outcome ID it viewed without clearing
another browser's indication. Bounded Host-owned retry details accompany addressed snapshots and
live events and retire outside retry phases. A valid `retrying` state remains visible if its detail
is unavailable.

## Snapshot synchronization and reconnect

### Authority and initial projection

HTTP bootstrap supplies configuration, a starting session address and the process-lifetime Host
authority. The addressed WebSocket subscription reads the initial projection once and publishes
it before releasing queued events. Validate the authority and interest revision before applying the
snapshot or publishing the socket as open. The runtime captures its event sequence when assembling
the snapshot. The socket replays only queued runtime events newer than that cut.

After a socket loss, attempt bounded WebSocket resume with the current address. A failed resume
falls back to metadata bootstrap; a newer selection replaces the socket's interest and invalidates
any previous projection still in flight. HTTP open remains an explicit selection operation.
Readiness sent before an open response arrives on the new addressed subscription's snapshot.

HTTP snapshot reads also carry an explicit session ID or an empty detail address. The last-opened
hint is used only to choose a new tab's starting address.

### Recovery triggers and deadlines

Missing first snapshots, application-frame inactivity, failed ping/pong, stale visibility return,
online transitions and BFCache restoration replace the transport through the same resume/bootstrap
boundary. Heartbeats cannot overtake a joining snapshot. Attempts use bounded deadlines and backoff:

- WebSocket establishment: 10 seconds.
- First authoritative snapshot after open: a separate 45 seconds, allowing Pi's 30-second read budget
  plus transfer time.
- Metadata bootstrap: 45 seconds. Each changed detail interest gets a separate 45-second
  observation budget, including the missing-detail fallback.

Heartbeats and stale snapshots do not extend deadlines. Expired sockets cannot apply late frames or
close callbacks to their replacement.

An addressed subscription to a confirmed-absent session publishes an empty snapshot and explains
the absence on the same connection. Keep the same owner/deadline and any newer committed
or pending navigation; do not adopt another browser's selection. Authentication failure, ambiguity,
projection corruption and unclassified read errors do not establish deletion.

Initial read-only hydration normally uses the cached catalog. If its pinned source disappeared,
moved or changed identity, refresh the catalog once and revalidate before opening. Ambiguity or
continued change refuses the read. This recovery neither replaces a live owned projection nor
retries a write. A missing open target refreshes the list while keeping the visible conversation.

Background snapshot failures keep confirmed content and retry with bounded backoff under the same
API, transport, selection and branch-view owner. Catalog, History and resource reads check their
owner before starting and before publishing. Their independent contributions keep their own addresses
and cancellation. A fresh snapshot
retires recovery. Superseded reads cannot publish warnings or restart retries. Commands and prompts
are never replayed; persistent synchronization loss follows [[workbench]].

## Selection and asynchronous completions

### Latest-wins ownership

Open/new/deselect responses require the original API client and explicit selection owner; each
transport replacement installs a new client. A newer open, new-session, deselection or transport
replacement supersedes the previous operation without serializing navigation. Every stream snapshot
names its detail subscription and revision. It refreshes that subscription while preserving a
newer HTTP selection intent. Successful new-session selection clears the previous opener. Each
operation can clear only its own opening state.
Every open/new endpoint finishes fallible projection and runtime-metadata reads before committing
selection or identity.

Bootstrap likewise captures its API identity. Only the current request may
publish metadata, load launch preferences, create a socket or interpret 401 as pairing failure.
An explicit selection committed during bootstrap sets the socket's initial address. Launch
continuation honors the intent captured before bootstrap began.
The last-opened hint supplies a starting address only when no browser location is available.
The read keeps that address through completion even if another request changes the hint.

HTTP resync success and failure share these fences, including same-session view replacement and
A → B → A navigation. A current-API 401 remains transport-wide; a replaced API's error is stale.
Obsolete operation completions cannot start a resync that invalidates the current pending read.
Abort error publication and native setting intents remain bound to their original selection
generation. Rename and prompt completions stay with the originating session's title, draft and
feedback.

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

Browser and Host share a closed contract for ordinary JSON queries and commands, including method,
address, input validation, typed response and observation policy. Authentication, origin checks,
native domain checks and byte transfers keep their own boundaries.

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
and terminal receipts keep their own identities.

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
no confirmation. Non-JSON error pages keep HTTP status and edge markers for connection feedback.

## Prompt delivery observations

The Host admits each random prompt operation id once for its process lifetime and checks that
a retry of uncertain input observes the original receipt without posting again. POST waits up to
20 seconds before returning a pending receipt. Authenticated GETs observe that receipt. Each browser request has a
30-second deadline. After a lost HTTP response, up to three consecutive receipt reads recover the
same operation. A valid pending receipt renews the read budget. Replacing the transport cancels
the browser observation while execution continues.

The browser API confirms a result only from a retained receipt with matching Host authority,
command and operation ID. Transport failures and unavailable or unknown receipts leave delivery
unconfirmed.
[[composer]] tracks the operation before dispatch. Retry delivery observes the same id even when
the draft or delivery selection has changed. Same-version tab reload restores the original
identity and request fingerprint for receipt observation. Unsupported records can be explicitly
retired. The stored record contains the proof used for observation and has no replayable input. After a Host
restart, the old result remains unknown and the user can inspect history before starting new input.

Prompt, terminal and restart tracking share bounded storage reads and writes. Each validates its
own current records before dispatch. A read failure blocks writes until the original record can be
checked. Invalid records require explicit retirement. The existing tab records retain their keys
and formats, and each executor keeps its own identity and receipt semantics.

## Pending handoff observations

Return and Stop bind dequeue results to Host authority, session, action and a random operation id.
Concurrent requests and unresolved-intent retries share that result. Newly observed runs or admitted
queues create new control intents; their actions cannot replay an earlier Stop/Return. Retain older
unclaimed results by id and observe them independently through receipt-only GETs, without dispatching
again or affecting later input.

Reconnect may observe a receipt while its old mutation observer is still pending. Only the current
API/transport owner restores it once into the original draft partition. Recovered images keep
ordinary staging ownership under [[composer]].

A matched rejected receipt ends that intent. A retired or missing receipt, plain HTTP 500,
mismatched proof and transport loss stay uncertain; retrying the same intent only observes.

Prompt, Return and Stop share one Host receipt table with command-specific fingerprints. It retains
at most 2,048 settled results and 32 MiB for 15 minutes. Process-lifetime tombstones prevent
redispatch or reuse of an ID for another command. The table refuses admission beyond 65,536
identities. Terminal receipts retain their own daemon admission epoch and expiry policy.

## Transcript views

`GET /api/history` serves bounded native pages, full branch text search, sibling routes, composer recall and entry
detail, with an explicit `sessionId` and `viewId`. Page cursors bind a fixed native leaf and an
earlier/later entry boundary. Search can find entries outside the current page, including before
compaction. Entry detail exposes bounded body sections and image metadata; image bytes use the
view-bound image endpoint. Live uses a separately bounded transcript tail. Each replacement
installs the rows, branch coordinates and persistence state from one Host event. Joining sockets
retain individual deltas so they can cut the backlog inside a stream batch.
The browser uses the same view replacement rules for full snapshots and Live checkpoints.
A live agent settlement carries its confirmed completion for the titlebar cue. A snapshot
supplies status without replaying that cue.

Each transcript snapshot/page carries an opaque branch-view generation and effective leaf.
Browser transcript readers validate the returned `viewId` against the request before applying
the response.
`active.transcriptPage` is the snapshot's single row authority; do not duplicate those rows in
`active.messages`. Explicit same-session navigation, worker reset and non-append replacement change
generation; ordinary appends do not. Signed history cursors bind the projection incarnation, file
generation, view, effective-leaf lineage and the revision from which page positions remain valid.
Append-compatible cursors stay usable across any number of appends. A file replacement invalidates
them even when the new file contains identical bytes. Late pages across a branch boundary are
aborted or discarded.

Pi system prompts/tool-loadout messages stay in Host canonical state, outside browser rows and live
overlays. Apply this consistently to compaction checkpoints, aggregate agent events, full/incremental
and reopened/branch views, History search, complete-entry preview and image access. Preserve SDK
entry identities and chronological compaction summaries; system placeholders produce no empty search
results. Filtering does not change native or saved entries. Use the ordinary
structured-key redaction policy without an extra text-redaction rule.

## Bounded streaming

### Ordered batches and recovery

Established sockets receive ordered coalesced assistant deltas. Clients joining behind snapshot
synchronization receive complete idempotent replacements. Flush same-message Host batches after
16 ms or before lifecycle/identity boundaries. Browser visual commits adapt from 16 to 50 ms as
text/argument previews grow. Coalesce adjacent updates to one tool while preserving `sourceEventCount`
and its original revision span, including through render-window batching and the 2,048-source-event
ceiling. Invalid identity, reconstructed length, serialization or size state requires an
authoritative snapshot instead of guessing across a gap.

An observed projection or branch change publishes its native rows, branch ownership and
diagnostics in one stamped detail frame. A rejected replacement recovers through a new addressed
snapshot on the stream.

Browser-only bounded Performance timeline measures expose bootstrap/prompt confirmation, WebSocket
handshake phase, snapshot characters and event-window frame/character rates, without persistent
telemetry.

### Overlay and tool output budgets

Trusted text/thinking and tool-argument appends account for JSON bytes, preview metadata and revision
growth without serializing cumulative messages. Enforce escaping, UTF-8, split-surrogate handling,
per-string/item caps and the total overlay budget. Structural changes, completed messages and
snapshots keep full projection validation. When a limit reduces or omits an item, send that bounded
replacement, not an old argument patch against the browser's larger tree.

Live execution carries one Host-authored `outputPreview`, computed before general projection from
the cumulative result: at most 16,000 characters and 400 tail lines. Reconnect uses the same preview;
do not duplicate `partialResult.content`. Keep projected details and child-call metadata, and use
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
`message_end` keep Pi ownership and ordinary transcript bounds.

Parser ownership belongs to the worker/current assistant message, survives interleaved extension
messages and peer calls, and retires on call/message completion or worker replacement. Reconnect
carries the bounded typed call, preview and stream revision, not parser state. Updates continue against
that identity without reparsing old JSON or recreating the card. Older public Pi starts without
identity/name publish only the completed call.

## Checks

- `session-detail-confirmation.test.ts` checks HTTP/WebSocket synchronization through browser
  routing. `store.test.ts` checks invalid acknowledgements. `app-events.test.ts` checks unchanged,
  changed and foreign authorities. Its stable window over 500,000 characters uses under 2,000
  bytes of synchronization and queued lifecycle frames.
