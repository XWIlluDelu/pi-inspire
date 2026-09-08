---
purpose: Existing Pi JSONL session trees remain the single conversation authority while inspire adds fast discovery, switching, continuation, and safe handoff.
covers:
  - shared/contracts.ts
  - shared/assistant-stream.ts
  - server/session-catalog.ts
  - server/session-metadata.ts
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
  configuration.

- A session can be listed, searched, opened, continued, named, and switched using Pi’s identity and
  tree rather than copied into another conversation store.

- Session listing retains only bounded name, first-user-text, working-directory, count, and
  timestamp metadata. The host keys each rebuildable JSONL summary by filesystem identity and stat
  version: unchanged files reuse their bounded summary, same-inode growth under the one-writer rule
  scans only the prior incomplete tail and new bytes, and other detected changes rebuild that file
  without retaining full message text. It owns a deterministic newest-first filtered order plus
  validated bounded `offset`/`limit` and total.

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
  cursor, and uses latest-wins reset semantics for query and explicit refresh. Session and project
  curation reclassify known rows synchronously; only newly off-page owners run bounded id/cwd
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
