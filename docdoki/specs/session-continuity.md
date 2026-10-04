---
purpose: Existing Pi JSONL session trees remain the single conversation authority while inspire adds fast discovery, switching, continuation, and safe handoff.
covers:
  - shared/contracts.ts
  - shared/assistant-stream.ts
  - server/session-catalog.ts
  - server/pi-session-directory.ts
  - server/project-directories.ts
  - server/session-metadata.ts
  - server/session-search.ts
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
  - tests/server/app.test.ts
  - tests/server/mock.test.ts
  - tests/server/model-catalog.test.ts
  - tests/server/session-delete.test.ts
  - tests/server/session-catalog.test.ts
  - tests/server/session-metadata.test.ts
  - tests/server/pi-session-directory*.test.ts
  - tests/server/project-directories.test.ts
  - tests/server/project-discovery.integration.test.ts
  - tests/server/runtime.test.ts
  - tests/server/runtime-branching.test.ts
  - tests/server/runtime-projection.test.ts
  - tests/server/pi-rpc.test.ts
  - tests/browser/workbench.spec.ts
  - tests/server/session-projection.test.ts
  - tests/web/app.test.tsx
  - tests/web/nav-render.test.tsx
  - tests/web/store*.test.ts
  - tests/web/connection-controller.test.ts
  - tests/web/events.test.ts
  - tests/web/welcome-new-session.test.tsx
---

# Session continuity

## Goal

Let the user move between existing terminal Pi and inspire without losing history or learning a second session system.

## Contract map

- [[session-persistence]] — read-only preview, worker startup, writer admission, and extension-request ownership.
- [[session-transport]] — per-browser detail, reconnect, asynchronous completion fences, and transcript views.
- [[session-branches]] — tree navigation, edit-from-here, and independent fork publication.
- [[session-deletion]] — Hidden confirmation, all-target preflight, and destructive commit boundaries.

## Checks

### Discovery and bounded catalog

- inspire discovers sessions from the same Pi session storage selected by the user’s Pi
  configuration. For each known worker working directory, a nonempty inherited
  `PI_CODING_AGENT_SESSION_DIR` precedes Pi's project/global `sessionDir` setting; an absent
  or empty override falls through. Pi owns path normalization, and relative storage paths
  resolve against that worker's working directory, not the Host's.

  Discovery covers the Host startup directory, saved pinned/Hidden project directories, and
  directories the Host has created or opened sessions in, including after Host reconstruction.
  A private, lock-merged, atomically replaced cwd-only index beside the preferences file retains
  these discovery roots independently of navigation curation. It stores no session identities,
  storage paths, or history. New-session creation saves the resolved cwd before constructing Pi;
  a failed or uncertain startup cannot orphan a possibly created session, and a failed index
  write prevents creation. Opening an existing session also remembers its resolved cwd.
  Legacy saved project folders seed the index, including before their first Unpin/Unhide or
  deletion-cleanup mutation. Removing curation never removes discovery knowledge.

  Each scan derives storage from current Pi environment/settings, not remembered storage paths.
  Custom storage is flat; default storage scans Pi's project subdirectories. Shared or overlapping
  roots contribute each file once. Saving project-folder curation invalidates discovery so newly
  included project settings participate in the next scan. Missing storage contributes no sessions;
  deleted files disappear on refresh, while missing project roots remain known for later return
  or external storage. The Host never searches overridden storage as a fallback, nor traverses
  arbitrary filesystem trees to find projects. Pi-reported relative session files resolve against
  the worker cwd for creation, snapshots, and startup identity checks.

- A session can be listed, searched, opened, continued, named, and switched using Pi’s identity and
  tree rather than copied into another conversation store.

- Session listing retains only bounded name, first-user-text, working-directory, count, and
  timestamp metadata. The host keys each rebuildable JSONL summary by filesystem identity and stat
  version: unchanged files reuse their bounded summary, same-inode growth under the one-writer rule
  scans only the prior incomplete tail and new bytes, and other detected changes rebuild that file
  without retaining full message text. It owns a deterministic newest-first filtered order plus
  validated bounded `offset`/`limit` and total.

  Nonempty catalog queries separately search Pi session name, cwd, session ID, and complete retained
  user/assistant text, including retained branches and text beyond the bounded first-message
  summary. Tool output, thinking blocks, and non-text content do not enter this text corpus. Queries
  use the installed Pi selector's multi-keyword/fuzzy tokens, whitespace-normalized quoted phrases,
  and case-insensitive `re:` regex; invalid or empty regex yields no matches. Results remain in
  chronological catalog order with authoritative totals and explicit pagination, not a filter over
  the browser's already-loaded rows.

  Search reads one session's complete admitted JSONL prefix at a time without retaining a
  whole-catalog conversation cache. Same-inode append may continue while that prefix is read under
  Pi's one-writer rule; equal-size observations require an unchanged stat version, and truncation,
  replaced/rebound paths, or changed header identity fail the query rather than searching a cached
  or replacement conversation. An isolated worker loads the installed selector's internal
  parser/matcher only for search, keeping synchronous parsing/fuzzy/regex work off the Host event
  loop. Request cancellation retires obsolete workers; a 30-second deadline makes an expensive
  query retryable with a simpler expression. Missing/incompatible selector internals fail search,
  not ordinary listing or Host startup. Evidence and the internal-module compatibility boundary:
  [[follow-session-search-2026-10-02]].

  A root scan failure aborts the refresh instead of publishing a partial catalog, and a present
  session that becomes temporarily unreadable or malformed retains its last complete summary; open
  and delete consumers revalidate the current path, source identity, and header before acting on
  that retained record. Duplicate Pi session ids are omitted from navigation and every id-addressed
  operation rejects the ambiguity instead of selecting a path. The browser's bounded
  `SessionCatalogController` owns list request generations, chronology pagination, curation/live
  hydration, and retry presentation through the `AppStore` facade; it does not own a second catalog
  snapshot.

  It keeps chronological base pages separate from curated/live hydration, advances only by
  `response.offset + response.sessions.length`, deduplicates identities without changing that
  cursor, and uses latest-wins reset semantics for query and explicit refresh. Retiring a list
  generation also aborts its pending HTTP observation and corresponding full-content search;
  generation ownership still rejects late responses from transports that ignore cancellation.
  Session and project curation reclassify known rows synchronously; only newly off-page owners run bounded id/cwd
  hydration, without resetting chronology or presenting the confirmed catalog as globally loading.
  All id and cwd hydration unions are deduplicated and split within their host route bounds;
  authentication loss follows the shared auth boundary, while other partial hydration failures
  retain the last confirmed base/curated union and expose a retryable warning.

  A standalone selected/live lookup failure retries only its generation-bound id hydration and
  merges that row without changing the base extent; query or list refresh invalidates stale
  ownership. Older-page failures retain confirmed pages for retry. Settlement hints atomically
  refetch the already consumed extent in bounded sequential pages under one generation—even beyond
  one server page—and a failed retry retains and targets that exact extent instead of collapsing
  navigation back to page zero. Successful deletion removes committed rows immediately, then runs
  the same authoritative preservation in the background to repair totals and offsets without
  reviving completed-list loading chrome.

### Navigation and curation

- Navigation exposes current work, unseen completion, and unresolved recovery per session: running,
  successful completion awaiting review, and error completion awaiting review remain distinct until
  the user opens that session. A healthy external-change conflict instead derives a yellow recovery
  indicator for as long as the conflicted session is in the background; selecting it moves recovery
  to the topbar chip and persistent banner, and only explicit recovery clears the conflict.

- Persistent pin, folder pin/Hidden, session Hidden, and folder-collapse metadata belongs to inspire
  preferences, not Pi JSONL. Curated sessions are hydrated by id and curated folders by exact
  working directory, so off-page pins stay reachable, Hidden remains reversible, and a folder
  curated as a whole stays complete. Folder-level state is independent of per-session state,
  bounded, and never dependent on the first chronological catalog page.

## Non-goals

- The product does not coordinate independent Pi runtimes as concurrent writers for one session.
- The rebuildable session-metadata index never becomes conversation authority.
