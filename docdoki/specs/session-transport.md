---
purpose: "Every event socket and asynchronous browser completion remains bound to its session, view, and transport generation across reconnect and concurrent navigation."
covers:
  - server/app.ts
  - server/runtime-event-sockets.ts
  - server/runtime.ts
  - shared/{contracts,assistant-stream}.ts
  - src/{api,events,store,snapshot-transition,transport-performance}.ts
  - src/controllers/{connection,session-selection,runtime-event,transcript-data}-controller.ts
  - tests/server/app.test.ts
  - tests/web/{events,store,store-transcript,store-navigation}.test.ts
---

# Session transport and browser ownership

## Goal

Reconstruct one current browser projection from Pi without unbounded transport queues or stale
writebacks. This is the transport part of [[session-continuity]], not a second conversation store.

## Checks

### Per-browser detail and reconnect

- Each authenticated event connection owns one explicit session-detail interest (or no detail).
  Selection changes fence detail delivery behind a fresh addressed snapshot and subscription
  revision, including in-flight initial handshakes and reconnects; another browser's Host selection
  cannot retarget that connection. Other sessions send only changed compact status and lifecycle
  outcomes, with an attention indicator for pending extension interaction, not
  message/tool/queue/dialog bodies. The Host filters before encoding those bodies and preserves its
  bounded joining backlog and event-batch ordering for interested clients.

- Refreshing or reconnecting reconciles live events against an authoritative Pi snapshot without
  duplicating settled messages or letting a delayed snapshot replace a newer selection. Bootstrap
  and the WebSocket's first snapshot carry one process-lifetime Host authority plus a SHA-256
  snapshot digest, and a WebSocket is not published as open until that authority and snapshot have
  been validated and applied. After a synchronized socket loss, the browser first opens a bounded
  lightweight WebSocket resume naming its last confirmed digest: the Host returns a digest-only
  unchanged confirmation when it still matches or a complete authoritative snapshot when it does
  not; a failed resume falls back to bootstrap rather than rereading bootstrap metadata on every
  healthy reconnect.

  A missing first snapshot, application-frame inactivity, failed server ping/pong, stale visibility
  return, online transition, or BFCache restoration replaces the old transport through that same
  resume-or-bootstrap boundary. Server heartbeats never overtake a joining snapshot, and both
  snapshot and reconnect attempts remain bounded by deadlines and backoff. Established sockets
  receive ordered Host-coalesced assistant deltas rather than repeated cumulative messages, while a
  socket joining behind snapshot synchronization receives complete idempotent message replacements.
  The Host flushes a same-message batch after 16ms or before a lifecycle/identity boundary; the
  browser reduces that ordered batch and adapts visual commits from 16ms to 50ms as the
  streamed text grows.

  Invalid identity, reconstructed length, serialization, or size state fails to an authoritative
  snapshot instead of guessing across a sequence gap. Bootstrap itself is latest-wins: each request
  captures its API identity and transport generation, and only the still-current request may apply
  bootstrap state, load launch preferences, create a WebSocket, or interpret a 401 as pairing
  failure. Browser-only, bounded Performance timeline measures expose bootstrap confirmation, prompt
  confirmation, WebSocket handshake phase, snapshot characters, and event-window frame/character
  rates without creating persistent telemetry. If selection changes while the host is reading a
  snapshot, it retries against the new owner before sending anything authoritative.

  Browser selection operations carry one explicit owner: the bounded `SessionSelectionController`
  accepts an open/new/deselect response only while its API client, transport generation, and
  explicit owner still match the `AppStore` facade. A newer open, new-session, authoritative stream
  snapshot, bootstrap, or transport replacement supersedes the older opener without serializing
  navigation; a successful new-session selection clears the prior opener, and stale
  completion/finally paths cannot clear a newer owner. Every open/new endpoint completes all
  fallible projection and runtime-metadata reads before its selection or identity commit.

  Fork validates its private destination before publication; once that complete JSONL is atomically
  published, any later attachment failure reports the exact committed destination and cannot become
  a retryable outcome. Catalog invalidation and observer notification are best-effort post-commit
  work and can never turn an operation that already changed host or disk state into an apparently
  uncommitted failure. Entering the New session surface calls an explicit host deselection
  operation; the selected session id becomes null in both host and browser while the old idle worker
  may remain only as an unselected LRU cache entry.

  The transition clears conversation-derived status, resources, attention acknowledgement, and
  Escape targeting, so the previous session becomes eligible for deletion and no browser-only
  "drafting" identity can diverge from runtime ownership. Rename and prompt completions remain bound
  to their sending/opening session and cannot retitle, clear drafts, or replace a visible error
  belonging to another session. Projection conflicts carry a machine-readable kind and opaque
  incident id rather than requiring message-text inference: a stopped worker whose healthy
  projection only moved to an external source is a persistent yellow attention state that still
  blocks writes and offers recovery; incomplete persistence, projection failure, and
  acceptance-unknown outcomes remain red blocking errors.

### View-bound transcript and bounded streaming

- Every transcript snapshot/page carries an opaque branch-view generation plus its effective leaf.
  The selected snapshot has one transcript-row authority at `active.transcriptPage`; it does not
  duplicate those rows through a compatibility `active.messages` field. Explicit same-session
  navigation, worker reset, and non-append replacement change the generation; ordinary append
  continuation does not. Older-page cursors bind both view and effective-leaf lineage, and the
  browser aborts/discards a page that completes after a branch boundary.

- Assistant overlay text/thinking deltas produced by the trusted reducer account for appended
  JSON bytes and stream-revision growth without serializing cumulative messages. Escaping,
  UTF-8, split surrogates, per-string caps, per-item caps, and the total overlay budget remain
  enforced. Structural changes, authoritative message completion, and snapshots retain full
  projection validation.
