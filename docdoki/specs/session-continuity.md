---
purpose: Existing Pi JSONL session trees remain the single conversation authority while inspire adds fast discovery, switching, continuation, and sharing with terminal Pi.
covers:
  - shared/contracts.ts
  - shared/session-activity.ts
  - shared/user-message.ts
  - server/pi-session-activity.ts
  - server/attach-control.ts
  - extensions/attach-control.ts
  - extensions/inspire-session-bridge.ts
  - tests/server/attach-control*.test.ts
  - tests/web/session-activity.test.tsx
  - shared/assistant-stream.ts
  - server/session-catalog.ts
  - server/pi-session-directory.ts
  - server/project-directories.ts
  - server/session-metadata.ts
  - server/session-search.ts
  - server/session-search-query.ts
  - server/session-search-worker.ts
  - server/session-jsonl.ts
  - server/session-preview.ts
  - server/session-projection.ts
  - server/session-delete.ts
  - server/model-catalog.ts
  - server/pi-rpc.ts
  - server/preferences.ts
  - server/resources.ts
  - server/runtime*.ts
  - server/app.ts
  - src/api.ts
  - src/events.ts
  - src/store.ts
  - src/transport-performance.ts
  - src/app-state.ts
  - src/App.tsx
  - src/controllers/connection-controller.ts
  - src/controllers/branch-controller.ts
  - src/controllers/composer-controller.ts
  - src/controllers/git-controller.ts
  - src/controllers/session-catalog-controller.ts
  - src/controllers/session-selection-controller.ts
  - src/controllers/session-management-controller.ts
  - src/controllers/runtime-event-controller.ts
  - src/controllers/transcript-data-controller.ts
  - src/components/EarlierBranchBanner.tsx
  - src/styles.css
  - src/styles/*.css
  - src/session-drafts.ts
  - src/model-options.ts
  - src/components/Composer.tsx
  - src/components/Nav.tsx
  - src/components/NavSessions.tsx
  - src/components/nav-model.ts
  - src/components/HiddenClearDialog.tsx
  - src/components/SessionDeleteDialog.tsx
  - src/components/Welcome.tsx
  - src/components/Transcript.tsx
  - src/components/BranchTree.tsx
  - server/session-tree.ts
  - tests/server/{app,app-events}.test.ts
  - tests/server/model-catalog.test.ts
  - tests/server/session-delete.test.ts
  - tests/server/session-catalog.test.ts
  - tests/server/session-metadata.test.ts
  - tests/server/pi-session-directory*.test.ts
  - tests/server/project-directories.test.ts
  - tests/server/project-discovery.integration.test.ts
  - tests/server/runtime-{selection,worker-pool,worker-lifecycle}.test.ts
  - tests/server/runtime-branching.test.ts
  - tests/server/runtime-{materialization,persistence-ownership,startup-attestation}.test.ts
  - tests/server/pi-rpc.test.ts
  - tests/browser/session-navigation.spec.ts
  - tests/server/session-projection.test.ts
  - tests/web/app.test.tsx
  - tests/web/readonly-session.test.tsx
  - tests/browser/readonly-session.spec.ts
  - tests/web/nav-render.test.tsx
  - tests/web/store*.test.ts
  - tests/web/connection-controller.test.ts
  - tests/web/events.test.ts
  - tests/web/welcome-new-session.test.tsx
---

# Session continuity

## Goal

Move between native Pi and Inspire using Pi's existing identities and session trees, without losing
history or introducing a second conversation store.

## Contract map

- [[session-persistence]] — read-only preview, worker startup, writer admission and extension requests.
- [[session-transport]] — per-browser detail, reconnect, asynchronous completion and transcript views.
- [[session-branches]] — History inspection, navigation, edit-from-here and independent copies.
- [[session-deletion]] — confirmation, all-target preflight and destructive commit boundaries.

## Storage discovery

Discover storage using the user's Pi configuration for each known worker cwd. A nonempty inherited
`PI_CODING_AGENT_SESSION_DIR` precedes project/global `sessionDir`; an absent or empty override falls
through. Pi owns normalization. Relative storage paths and Pi-reported session files resolve against
the worker cwd for creation, snapshots and startup checks, not against the Host cwd.

Discovery covers the Host startup directory, saved pinned/Hidden project directories, and directories
where the Host has created or opened sessions, including after Host reconstruction. A private,
lock-merged, atomically replaced cwd-only index beside preferences retains these roots independently
of curation. It stores no session identities, storage paths or history. Folder curation writes seed
legacy roots before Unpin, Unhide or folder deletion cleanup, so the projects remain discoverable.

Retain a resolved cwd in memory before attempting to save this hint. Save failure is logged and
retried during later catalog refreshes, without rejecting creation, startup, input or history reads.
Unsaved roots cannot survive Host reconstruction through this index alone.

Each scan resolves storage from the current environment and settings. It shares one global settings
read across known projects and applies each project's own overrides. Custom storage is flat; default
storage scans Pi's project subdirectories. Overlapping roots contribute each file once. Saving folder
curation invalidates discovery so newly included project settings enter the next scan. Missing
storage contributes no sessions, and deleted files disappear on refresh. Missing project roots
remain known for later return or external storage. Do not search overridden storage as a fallback
or traverse arbitrary filesystem trees to discover projects.

## Readable history when execution is unavailable

A missing project directory preserves transcript, History inspection, Copy and local information
queries. Show a short neutral explanation in the composer's place; disable session-writing and
execution controls but keep navigation and preference controls. Reselecting requests a fresh
open so a restored directory can become usable. [[session-persistence]] owns source validation and
worker admission.

A session a live terminal Pi is running on the viewed branch keeps the same reading surface, with
that Pi's progress and **Take over** in the composer's place. The view rechecks presence
automatically while preserving unsent input; [[session-persistence]] owns admission.

## Catalog metadata and search

### Titles and bounded summaries

Automatic titles share the transcript/live-header user-content projection. Exclude model-facing file
trailers and image-dimension notes; file-only input uses readable filenames. Explicit session names
take precedence. Title extraction changes neither persisted messages nor searchable file paths.

Listing keeps only bounded name, first-user caption, cwd, count and timestamps. Rebuildable
summaries are keyed by file identity/stat version. Reuse unchanged summaries; for same-inode growth,
scan the prior incomplete tail and new bytes; rebuild other detected
changes without retaining full message text. The Host owns deterministic newest-first ordering, validated
bounded `offset`/`limit`, and totals.

### Query semantics and source admission

Search session name, cwd, id and complete retained user/assistant text, including alternate branches
and text beyond the first-message summary. Exclude tool output, thinking and non-text blocks.

- AND case-insensitive fuzzy tokens, each matching a character subsequence within one field.
- Match quoted phrases against whitespace-normalized text.
- A leading `re:` selects a case-insensitive regex over combined fields. Invalid/empty regex and
  unclosed quotes match nothing.

Results keep chronological catalog order, authoritative totals and explicit pagination; they are
not a filter over loaded browser rows. Reuse the last successful query across pages while its
catalog generation and admitted source records remain unchanged; failed or partial scans do not
become reusable results. [[workbench]] owns labels, emphasis and search interaction.

Read one session's complete admitted JSONL prefix at a time, without a whole-catalog conversation
cache. Same-inode appends may continue beyond that prefix. Equal-size observations require an
unchanged stat version. Truncation, replaced/rebound paths and changed header identity exclude the
source and report it unavailable; never substitute cached or replacement content. Other admitted
sources still contribute results, whose totals cover only successfully searched sources.

Run synchronous parsing/fuzzy/regex work in an isolated cancellable worker using Inspire's matcher,
without private Pi dependencies. Cancellation retires obsolete workers; the 30-second deadline
allows an expensive query to be retried with a simpler expression.

### Unavailable and ambiguous sources

Isolate directory and file failures. Publish healthy sources and keep last complete summaries for
known rows under unavailable sources; a present malformed session may likewise keep its summary for
inspection. Missing roots remain distinct from unreadable roots.

Pages carry bounded `issues`: the first 20 unavailable paths and explanations. An expandable source
notice and refresh action accompany available history. Incomplete-page counts are not complete
catalog counts; successful refresh clears the notice.

Ordinary open and individual delete revalidate the addressed path, identity and header. Unknown ids
in an incomplete catalog are not confirmed absent. Hidden clearing requires a fresh complete scan
before any destructive step. Omit duplicate Pi ids from navigation and reject every id-addressed
operation on that ambiguity rather than choosing a path.

## Browser catalog continuity

One browser catalog owner manages request generations, chronological pages, curated/live hydration
and retries through the application state facade. It does not keep a parallel catalog snapshot.

Keep chronological base pages separate from hydration. Advance pagination only by
`response.offset + response.sessions.length`; identity deduplication does not change that cursor.
Query changes and explicit refresh replace the generation and abort its pending HTTP observation
and content search. Generation checks also reject late replies from transports that ignore abort.

Curation changes reclassify known rows synchronously. Hydrate only newly off-page session ids and
exact cwds, deduplicating and splitting their unions within route bounds. Preserve chronology and
confirmed rows without global loading or manual hydration controls. Authentication loss follows the
shared transport boundary; other partial failures keep the confirmed base/curated union and retry in
the background with bounded backoff. A selected/live id can precede its catalog row: a successful
lookup that has not found it yet is a materialization delay, not a failure.

Standalone selected/live lookup retries only that generation's id hydration and merges the result
without changing the base extent. A new query, list refresh or lost owner interest retires its
recovery. Foreground initial, search and older-page failures keep local retry controls.

Settlement hints atomically refetch the consumed extent in bounded sequential pages under one
generation, even beyond one server page. Background retries keep that extent instead of collapsing
to page zero. Deletion removes committed rows immediately, then uses the same background refresh to
repair totals and offsets without reintroducing completed-list loading UI.

## Navigation and curation

Keep running work, successful completion awaiting review, and error completion awaiting review
distinct until the user opens the session. A healthy external-change conflict keeps a yellow
recovery indicator in navigation; selecting it shows recovery in the topbar and persistent banner.
Only explicit recovery clears that conflict.

Pins, folder pin/Hidden, session Hidden and folder-collapse state belong to Inspire preferences,
not Pi JSONL. Hydrate curated sessions by id and folders by exact cwd so off-page pins stay reachable,
Hidden remains reversible, and folder sections stay complete. Folder curation works independently
of session curation and includes folders beyond the first chronological page. A folder lookup
returns all matching sessions in catalog order or rejects the request if the combined result
exceeds its limit.

## Shared sessions with terminal Pi

### attach-control

`extensions/attach-control.ts` is a generic, user-installed Pi extension, independent of Inspire,
the launcher and Herdr; the Host never installs or injects it. Each live session context publishes
a private record (session id/file, current leaf, activity, model, process birth identity, endpoint
and token) and serves a local socket for public-API operations: state, prompt, abort, rename,
models, model and thinking, reload (through its own command so Pi applies command semantics),
dialog answers and shutdown. Records are written atomically, removed on session
shutdown, and dropped by readers when their process identity no longer matches. `PI_ATTACH_CONTROL=0`
disables it; Inspire sets this for its own workers. The former bridge paths forward to it.
See the [extension guide](../../docs/extensions.md#share-sessions-with-terminal-pi).

Final settlement, not `agent_end`, clears work so retries and queued continuations stay busy.
Blocking input is distinct from active work. Bounded task results let Inspire distinguish
completion, failure and cancellation, including short runs between polls.

### Activity in the browser

Poll about every two seconds, matching both session id and absolute file against the unambiguous
catalog. Records cannot expand discovery roots. Failed observation and browser disconnect clear the
activity map: missing evidence is unknown, not idle or completed. Repeated full maps provide
reconnect baselines and hydrate rows without changing pagination. Count busy identities once
alongside managed workers for titlebar density; waiting for input does not increase the count.
External activity does not block deletion; [[session-deletion]] owns its confirmation.

### Sharing

Terminal Pi and Inspire may use one session at the same time; there is no handoff, release step or
terminal mode. **Copy resume command** copies a correctly quoted change-directory and
`pi --session` command for POSIX shells or PowerShell and changes nothing. [[session-persistence]]
owns which view is read-only, takeover, and how appends from several processes are reconciled.

## New project creation

The New composer may explicitly create a missing project directory and start a session there.
Model/file discovery stays observational; opening existing history never recreates its cwd.
Only **Create folder and start** creates the path recursively, then canonicalizes it before discovery
registration and Pi admission. Existing files are not replaced or treated as missing directories.
Creation and startup are not atomic: startup failure can leave the directory while the browser
keeps untransferred input. [[composer]] owns the action and input handoff.

## Non-goals

- Lock or arbitrate between Pi processes writing one session. Several may append to it;
  [[session-persistence]] reconciles the result for each view.
- Make the rebuildable metadata index a conversation authority.
