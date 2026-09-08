---
purpose: Evidence and scope for the September 2026 simplification, ownership-boundary, oversized-file, and documentation review.
---

# Simplification review

## Repairs

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
  [[performance-evidence]]. No new performance improvement is claimed.

## File boundaries

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

## Document boundaries

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

## Focus regression found during verification

Three browser cases initially failed to restore the Settings/image opener. An
isolated StrictMode unit test reproduced the bug before the fix: layout-effect replay
captured the already-focused internal close button as the new restoration target.
Unmount then left focus on the document body.

`useModalFocus` now retains the previous entry's outside opener only when replaying
on the same dialog with focus still inside it. It retains the existing modal-stack,
nested restoration, and stale-microtask guards. The new test went from failing to
passing; the three affected modal suites passed all 11 tests. Production Chromium
subsequently passed both Settings variants and image dismissal/focus restoration.

## Verification and limits

- Linux, explicitly verified Node **22.23.2**, not the machine's default Node 26.
- Full `npm run check`: format, lint/import boundaries, TypeScript, Knip, production
  web build, **17 portable tests**, **1,226 unit/integration tests**, and **6 launcher
  tests** passed. Three tests were skipped across those suites.
- Production-build Chromium: **34 tests passed**, including persistent terminals,
  authenticated sockets, Pending clear, branch/session transitions, resources,
  loading states, and image/focus checks.
- The final gates ran in a disposable detached worktree, on an independent browser
  port, retaining this review plus the completed loading/directory/image changes.
  Another session's in-progress streaming-tool-argument implementation and tests
  were explicitly excluded; its later edits in the shared working directory are
  **not** covered by this result. The review's socket module was reconstructed from
  its original mechanical extraction for that snapshot.
- No macOS/Windows run, dependency upgrade, release publication, or daily Host restart
  was performed. Runtime diagnostics, authorization/reconciliation fences, current
  regression tests, and historical design evidence were not removed to achieve a
  cleanup target.
