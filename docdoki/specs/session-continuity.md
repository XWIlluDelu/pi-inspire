---
purpose: Existing Pi JSONL session trees remain the single conversation authority while inspire adds fast discovery, switching, continuation, and safe handoff.
covers:
  - shared/contracts.ts
  - shared/session-activity.ts
  - shared/user-message.ts
  - server/pi-session-activity.ts
  - server/pi-session-occupancy.ts
  - docs/examples/session-activity.ts
  - tests/server/pi-session-activity*.test.ts
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
  - src/components/SessionTerminalDialog.tsx
  - tests/server/session-handoff.integration.test.ts
  - src/components/Welcome.tsx
  - src/components/Transcript.tsx
  - src/components/BranchTree.tsx
  - server/session-tree.ts
  - tests/server/{app,app-events}.test.ts
  - tests/server/mock.test.ts
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
of curation. It stores no session identities, storage paths or history. Legacy saved folders seed it
before their first Unpin/Unhide or deletion cleanup; removing curation does not forget a project.

Retain a resolved cwd in memory before attempting to save this hint. Save failure is logged and
retried during later catalog refreshes, without rejecting creation, startup, input or history reads.
Unsaved roots cannot survive Host reconstruction through this index alone.

Each scan resolves storage from current environment/settings. Custom storage is flat; default
storage scans Pi's project subdirectories. Overlapping roots contribute each file once. Saving folder
curation invalidates discovery so newly included project settings enter the next scan. Missing
storage contributes no sessions, and deleted files disappear on refresh. Missing project roots
remain known for later return or external storage. Do not search overridden storage as a fallback
or traverse arbitrary filesystem trees to discover projects.

## Readable history when execution is unavailable

A missing project directory preserves transcript, History inspection, Copy and local information
queries. Show a short neutral explanation in the composer's place; disable session-writing and
execution controls while retaining navigation and preference controls. Reselecting requests a fresh
open so a restored directory can become usable. [[session-persistence]] owns source validation and
worker admission.

An unavailable external execution route preserves the same reading surface with a distinct
explanation, rather than reporting a missing folder. Viewed external read-only sessions recheck
owner availability automatically while preserving unsent input. The recovery and startup boundaries
in [[session-persistence]] determine when execution resumes.

## Catalog metadata and search

### Titles and bounded summaries

Automatic titles share the transcript/live-header user-content projection. Exclude model-facing file
trailers and image-dimension notes; file-only input uses readable filenames. Explicit session names
take precedence. Title extraction changes neither persisted messages nor searchable file paths.

Listing retains only bounded name, first-user caption, cwd, count and timestamps. Key rebuildable
summaries by file identity/stat version: reuse unchanged summaries, scan the prior incomplete tail
and new bytes for same-inode growth under the one-writer rule, and rebuild other detected changes
without retaining full message text. The Host owns deterministic newest-first ordering, validated
bounded `offset`/`limit`, and totals.

### Query semantics and source admission

Search session name, cwd, id and complete retained user/assistant text, including alternate branches
and text beyond the first-message summary. Exclude tool output, thinking and non-text blocks.

- AND case-insensitive fuzzy tokens, each matching a character subsequence within one field.
- Match quoted phrases against whitespace-normalized text.
- A leading `re:` selects a case-insensitive regex over combined fields. Invalid/empty regex and
  unclosed quotes match nothing.

Results retain chronological catalog order, authoritative totals and explicit pagination; they are
not a filter over loaded browser rows. [[workbench]] owns labels, emphasis and search interaction.

Read one session's complete admitted JSONL prefix at a time, without a whole-catalog conversation
cache. Same-inode appends may continue beyond that prefix. Equal-size observations require an
unchanged stat version. Truncation, replaced/rebound paths and changed header identity exclude the
source and report it unavailable; never substitute cached or replacement content. Other admitted
sources still contribute results, whose totals cover only successfully searched sources.

Run synchronous parsing/fuzzy/regex work in an isolated cancellable worker using Inspire's matcher,
without private Pi dependencies. Cancellation retires obsolete workers; the 30-second deadline
allows an expensive query to be retried with a simpler expression.

### Unavailable and ambiguous sources

Isolate directory and file failures. Publish healthy sources and retain last complete summaries
for known rows under unavailable sources; a present malformed session may likewise retain its
summary for inspection. Missing roots remain distinct from unreadable roots.

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
shared transport boundary; other partial failures retain the confirmed base/curated union and retry
in the background with bounded backoff. A selected/live id can precede its catalog row: a successful
lookup that has not found it yet is a materialization delay, not a failure.

Standalone selected/live lookup retries only that generation's id hydration and merges the result
without changing the base extent. A new query, list refresh or lost owner interest retires its
recovery. Foreground initial, search and older-page failures retain local retry controls.

Settlement hints atomically refetch the consumed extent in bounded sequential pages under one
generation, even beyond one server page. Background retries retain that extent instead of collapsing
to page zero. Deletion removes committed rows immediately, then uses the same background refresh to
repair totals and offsets without reintroducing completed-list loading UI.

## Navigation and curation

Keep running work, successful completion awaiting review, and error completion awaiting review
distinct until the user opens the session. A healthy external-change conflict retains a yellow
recovery indicator in navigation; selecting it shows recovery in the topbar and persistent banner.
Only explicit recovery clears that conflict.

Pins, folder pin/Hidden, session Hidden and folder-collapse state belong to Inspire preferences,
not Pi JSONL. Hydrate curated sessions by id and folders by exact cwd so off-page pins stay reachable,
Hidden remains reversible, and folder sections stay complete. Folder curation is independent of
session curation, bounded, and not limited to the first chronological page.

## External Pi activity

### Reporter lifecycle

One optional, user-enabled Pi extension reports activity for independent RPC hosts and TUI/JSON/print
modes. It uses supported lifecycle and aggregate UI-prompt events, adding no tools, prompts or session
entries. Observation is independent of execution connectors, the launcher and Herdr; the Host never
installs or injects it automatically. See the
[enable/reload procedure](../../docs/extensions.md#show-external-session-activity).
Inspire-owned workers keep their managed status rather than reporting twice; exclusion requires the
loaded internal GUI command, not RPC mode or inherited environment alone.

Reports contain session id/file, process id/birth identity, activity, heartbeat time and an
activity-stop hint in the user's private cache. Publish atomically and serially. Factory-only
discovery has no runtime side effects. Shutdown cancels resources without releasing writer presence;
if it overtakes asynchronous startup, no heartbeat may rearm. Reload reuses the manager's report.
A completed native replacement transfers its producer only for uniquely matching shutdown/start
metadata; independent SDK managers do not share the transfer. Dead-process reports may be collected.

Final settlement, not `agent_end`, clears work so retries and queued continuations stay busy.
Blocking input is distinct from active work. Reports eight seconds old, inactive, legacy-released,
or from exited processes no longer count as current activity. Activity expiry and stop hints do
not prove writer release; presence admission belongs to [[session-persistence]].

### Browser observations

Poll about every two seconds, matching both native session id and absolute file against the
unambiguous catalog. Reports cannot expand discovery roots or grant execution, Stop, restart or
writer ownership. Failed/stalled observation and browser disconnect clear the independent activity
map: missing evidence is unknown, not idle or completed. Repeated full maps provide reconnect
baselines and hydrate rows without changing pagination.

External activity does not block deletion; [[session-deletion]] owns its contextual confirmation and
managed-writer checks. Count busy identities once alongside managed workers for titlebar density;
waiting for input does not increase the count. There is no second Herdr-specific activity source.
Process-bound presence may require a read-only view, but never grants control of the reporting Pi.

## Explicit terminal handoff

Session actions return one Inspire-owned session to the native terminal without stopping the Host
or other sessions. A busy session first uses ordinary Stop/Pending recovery; recover pending input
before releasing the writer. Confirm actual worker retirement before offering a correctly quoted
project change-directory and `pi --session` command for POSIX shells or PowerShell. Inspire neither
executes the command nor modifies session history to record the handoff.

A session-id preference preserves terminal intent across selection, worker eviction and Host
reconstruction, and is removed with session deletion. The read-only view retains history, branch
JSONL export and the draft. **Continue in Inspire** explicitly clears that intent and uses ordinary
installed-Pi/external-owner admission. An external holder still vetoes a new writer or reconnects
through supported Herdr control. Handoff introduces no writer lease, multiwriter protocol or Herdr
dependency.

## New project creation

The New composer may explicitly create a missing project directory and start a session there.
Model/file discovery stays observational; opening existing history never recreates its cwd.
Only **Create folder and start** creates the path recursively, then canonicalizes it before discovery
registration and Pi admission. Existing files are not replaced or treated as missing directories.
Creation and startup are not atomic: startup failure can leave the directory while the browser
retains untransferred input. [[composer]] owns the action and input handoff.

## Non-goals

- Coordinate independent Pi runtimes as concurrent writers for one session.
- Make the rebuildable metadata index a conversation authority.
