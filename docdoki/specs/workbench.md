---
purpose: The product opens as a conversation-centered, collapsible workbench whose surrounding regions can grow without replacing the initial interface.
covers:
  - index.html
  - package.json
  - public/manifest.webmanifest
  - public/service-worker.js
  - public/app-icon.svg
  - public/app-icon-maskable.svg
  - shared/contracts.ts
  - server/app.ts
  - server/index.ts
  - server/preferences.ts
  - server/file-lock.mjs
  - server/static-asset-cache.d.mts
  - server/static-asset-cache.mjs
  - server/update-checker.ts
  - server/pi-update-checker.ts
  - server/update-coordinator.ts
  - server/semantic-version.ts
  - src/api.ts
  - src/main.tsx
  - src/store.ts
  - src/app-state.ts
  - src/controllers/preference-controller.ts
  - src/controllers/runtime-event-controller.ts
  - src/controllers/session-management-controller.ts
  - src/controllers/transcript-data-controller.ts
  - src/git-presentation.ts
  - src/controllers/git-controller.ts
  - src/controllers/workspace-controller.ts
  - src/controllers/update-controller.ts
  - src/update-availability.ts
  - src/install-app.ts
  - src/App.tsx
  - src/components/AppTopbar.tsx
  - src/components/EarlierBranchBanner.tsx
  - src/components/Nav.tsx
  - src/components/NavSessions.tsx
  - src/needs-you.ts
  - src/components/Welcome.tsx
  - src/components/DirectoryPicker.tsx
  - src/components/CommandPalette.tsx
  - src/components/CommandHelp.tsx
  - src/palette-search.ts
  - src/components/Composer.tsx
  - src/components/ExtensionUiDialog.tsx
  - src/components/ImagePreview.tsx
  - src/components/Settings.tsx
  - src/components/SettingsDialog.tsx
  - src/components/ContextPane.tsx
  - src/components/ContextPaneState.tsx
  - src/components/context-pane-view.ts
  - src/components/TerminalPane.tsx
  - src/components/TerminalSettingsDialog.tsx
  - src/components/TerminalView.tsx
  - src/terminal-actions.ts
  - src/components/FilesPane.tsx
  - src/components/FilePreview.tsx
  - src/components/ChangesPane.tsx
  - src/components/WorkspaceBrowser.tsx
  - src/components/BranchTree.tsx
  - src/components/PaneResizeHandle.tsx
  - src/components/CopyAction.tsx
  - src/components/HiddenClearDialog.tsx
  - src/components/SessionDeleteDialog.tsx
  - src/use-modal-focus.ts
  - src/keyboard-input.ts
  - src/visual-preferences.ts
  - public/theme-init.js
  - server/host-dirs.ts
  - server/host-hidden-dirs.ts
  - src/styles.css
  - src/styles/*.css
  - scripts/build-release.mjs
  - scripts/build-web.mjs
  - scripts/verify-release-package.mjs
  - scripts/web-build-output.mjs
  - scripts/source-build-hash.mjs
  - tests/server/app*.test.ts
  - tests/server/preferences.test.ts
  - tests/portable/file-lock.test.mjs
  - tests/server/host-dirs.test.ts
  - tests/server/host-hidden-dirs.test.ts
  - tests/web/directory-picker.test.tsx
  - tests/web/api.test.ts
  - tests/server/static-asset-cache.test.ts
  - tests/server/update-checker.test.ts
  - tests/launcher.test.ts
  - tests/portable/web-build-output.test.mjs
  - tests/server/pi-update-checker.test.ts
  - tests/web/app.test.tsx
  - tests/web/composer-*.test.tsx
  - tests/web/notices.test.tsx
  - tests/web/store-feedback.test.ts
  - tests/browser/feedback.spec.ts
  - tests/web/settings-navigation.test.tsx
  - tests/web/settings-loading.test.tsx
  - tests/browser/loading-states.spec.ts
  - tests/browser/needs-you.spec.ts
  - tests/web/update-controller.test.ts
  - tests/web/modal-focus.test.tsx
  - tests/web/overlay-and-palette.test.tsx
  - tests/web/command-ux.test.tsx
  - tests/browser/command-ux.spec.ts
  - tests/web/theme-init.test.ts
  - tests/web/nav.test.ts
  - tests/web/nav-render.test.tsx
  - tests/web/needs-you.test.ts
  - tests/web/workspace-controller.test.ts
  - tests/web/pane-resize.test.tsx
  - tests/web/branch-tree.test.tsx
---

# Workbench shell

## Goal

Give daily Pi work a conversation-centered interface with accessible session, file, and terminal controls.

## Contract map

- [[workspace-layout]] — responsive reading geometry, topbar identity, Git observation, and contextual modes.
- [[interface-preferences]] — Settings, ordered preference writes, update observations, and completion attention.
- [[host-lifecycle]] — atomic browser-build publication and retained executable assets.

## Canonical project and session navigation

- Navigation opens at the left by default. In All, each session has one position: individually
  pinned sessions first, then pinned and other folders grouped by working directory and ordered by
  newest activity, then Hidden. The stable position makes sessions easier to find again. Every row,
  including Hidden, shows runtime state through the mark and age color: working yellow, unseen
  completion green, unseen failure red, and attention warning-ringed. [[workspace-layout]] owns
  the aggregate count on the narrow and collapsed desktop navigation toggles.

  The conversation stays dominant in the center, and the right contextual region opens only when
  requested. Its Changes selector shows the same authoritative total as the topbar, capped visually
  at `99+` and omitted when the header is too narrow; the tooltip keeps the exact count. On narrow
  screens the contextual region uses the full-width modal drawer specified in [[workspace-layout]].

- Navigation owns New session, search and its collapse/expand controls. [[design-system]] defines
  their shared alignment and the installed-window header variant. The desktop rail's leading
  control expands navigation and its separate plus button starts a session. Keyboard
  collapse/expand from within navigation restores focus to the corresponding sidebar toggle; the
  same shortcut from the editor keeps editor focus. On narrow screens there is no rail: the topbar
  opens the full modal drawer, whose header closes it. [[workspace-layout]] owns toggle placement
  and the drawer's interaction with the desktop collapse state.

- Pinning and hiding are reversible navigation metadata that never touch Pi's session storage.
  They are mutually exclusive: hiding a session drops its pin, and restoring it returns it to its
  folder. Each change travels as a single preference patch so the two identity lists cannot
  disagree. Folder pins use the exact cwd identity that already defines groups and their collapse
  state.

- The header bell switches All to Needs you, a flat cross-project list. Its pressed state uses
  accent ink and tint. The count is green, or red when any session is waiting or failed.
  Needs you lists sessions waiting for input or recovery, then unseen failures, then unseen
  completions, newest activity first within each priority. Pinning changes the order in All.
  Needs you includes blocked terminal Pi sessions and excludes
  Hidden and sessions still working. Viewing clears an unseen outcome, while a row opened from
  Needs you stays in place for the selected session. Search uses the current mode. Folders, Pinned,
  pagination and Hidden belong to All. The browser remembers the mode with its other navigation
  disclosures. Header actions use 15px glyphs, 4px gaps and 28px mouse or 36px touch targets.

- In hover-capable layouts wider than 600px, an ordinary session row is a 32px line with the
  activity mark, title and trailing age. The activity mark sits right-aligned inside the same 16px
  icon slot and 8px label gap as folder rows. The status mark renders at 10px, scaled about its
  painted right edge and vertical centre without moving the slot, text axis or selection marker.
  The text axis stays reserved when no status is present. Cross-project rows (Pinned and Needs
  you), search excerpts, and narrow or non-hover layouts use two lines, with the title above
  metadata. Hidden separates its status mark from the selection marker.

  Desktop Pin/Hide or Restore/Delete appear at the trailing edge on hover or keyboard focus. On a
  one-line row they take the age's place and the title fades under them without changing width;
  while a session is opening, its Opening… status keeps that place and the actions wait. Two-line
  pointer rows are 44px high; coarse desktop rows keep visible 36px actions. On phone-width layouts or without hover the
  actions stay visible; phone-width or touch drawers keep their persistent 36px actions in a
  separate column beside both text lines. Pin and Hide stay directly accessible, not behind an
  overflow menu. The exact timestamp and message count stay in tooltips.

  Folder groups use the same spacing in the catalog and Hidden, including the transition from a
  pinned folder to an ordinary folder. The titled Pinned sessions section has its own spacing
  under [[design-system]]. The title/age line boxes stay at 18/16px with a 1px gap on two-line
  rows; density changes do not squeeze individual rows. Folder headers
  keep their label tier, persistent pin state and trailing session count. Desktop New/Search,
  folder headers and session-row surfaces share the same outer inset; their internal icon/text axes
  stay stable.

  Hidden's full-width dock header stays distinct from its inset contents; its root folders and row
  surfaces use the normal project axes without an extra section-wide indent. Independent hidden
  sessions stay at that root text axis; grouped sessions keep the compact desktop layout rather
  than adding another 20px indent. Hidden lists independent sessions before folders and their
  children, preserving each category's existing order, and keyboard search navigation follows that
  visual order. A folder following independent sessions keeps the same root inset and spacing
  used between folders.

- Project groups expose native expand/collapse controls across the header's main button. A single
  open/closed folder icon conveys the state with no separate disclosure arrow, leaving more width
  for the folder name. The button keeps its name and `aria-expanded` state. A collapsed group
  containing the visible session carries the active highlight on its header, and active search
  results stay visible regardless of saved collapse state.

  Hidden is a bottom curation drawer outside the session list's scroll area. Its neutral 44px
  header leaves space around the label and aligned icons, with the count at the trailing edge
  before the disclosure indicator. The header precedes its content; Hidden's independently
  scrolling body is bounded to leave room for ordinary navigation. Both scrollports keep enough
  height for complete rows in short windows, including safe-area insets. When those minimums cannot
  fit alongside New/Search and the drawer header, navigation itself scrolls rather than compressing
  a list into a sliver. Normal-height navigation keeps independent list scrolling and its existing
  spacing. Opening Hidden reveals its body without transferring focus.

  Project identity on cross-project Hidden rows is quiet text, not a filled badge. On phone-width
  or non-hover layouts, all cross-project rows (Pinned, search and Hidden) place project and age
  beneath the title so persistent actions do not crowd it. Selection and search highlights cover
  the whole row, including its action area.

  The drawer defaults closed and keeps its state when the tab reloads. It is absent when there
  are no hidden results. Search
  reveals matching hidden sessions inside it instead of returning them to their folders. Ordinary
  session-entry surfaces, including Welcome recents and the command palette's recents/search, share
  the hidden-session/project filter; hidden sessions stay in the Hidden drawer instead of
  reappearing as ordinary recommendations.

  Ordinary rows keep Pin and Hide; Hidden rows reuse those two action slots for Restore and Delete,
  so deletion is a second-stage action rather than a third always-present icon. Every hidden
  session, including a child of a hidden folder, has both Restore and Delete in those fixed columns.
  Restoring a child resolves the complete folder through the catalog, restores only that session
  and keeps all siblings individually hidden. A failed lookup or newer Hidden edits leave the prior
  curation intact. Folder headers have the same Restore/Delete columns. Folder Delete confirms the
  count and full path and clears only that complete hidden folder.

  Clear Hidden is a persistent header icon action between the count and disclosure, with its own
  accessible name and click target; it does not consume a content row. The count and controls keep
  their positions when the drawer opens or closes. Independent hidden session titles start farther
  left than folder contents, so a row following a folder does not look like its child; complete
  hidden folders keep their own nested indentation. Clear empties the entire drawer through one
  count-bearing confirmation covering both individually hidden sessions and every session in
  complete hidden folders. It is unavailable while search or curation hydration can show only a
  partial selection, and while any target is opening, working in Inspire, or conflicted. A
  folder-level deletion applies the same conditions to that folder only. Viewing an idle target or
  observing it in an external Pi terminal does not block deletion; [[session-deletion]] owns
  idle-worker retirement and the contextual terminal consequence. Session deletion leaves project
  files and project folders unchanged.

### Search and pagination

- Search stays in the sidebar. [[session-continuity]] owns catalog fields, query syntax and source
  authority. When the title does not match, a returned message excerpt takes the place of the age.
  [[design-system]] owns visible match emphasis.

  Search reveals the immediate parent beside a project group when that parent has a visible
  token/phrase match but the project basename does not. Existing context for colliding basenames
  remains. Both contexts use `project @parent`; the `@` marker uses secondary text styling and is
  excluded from match emphasis. Cross-project session locations have no `@` prefix: they show the
  project basename, expanding to `parent/project` only when the parent matches and neither title
  nor basename does. That expansion temporarily replaces age metadata; ordinary browsing restores
  basename and age. Regex results have no match emphasis.

  Focusing an empty search input does not highlight or open a session. Unmodified Up/Down starts
  deliberate result navigation, even with an empty query; a non-empty query defaults to its first
  result. Clearing the query or leaving and refocusing an empty input resets that transient
  highlight. While the search input owns focus, Up/Down follows the same project/Pin/Hidden order
  as navigation and Enter opens only the highlighted identity. Focus stays in the input, the
  highlighted row scrolls into view, and a live status names the choice for assistive technology.
  Highlighting is distinct from the opened session. The same identity survives page append,
  same-query refresh, and curation reordering; a changed query cannot open an old result while its
  response is pending. Modifier-based text editing and IME composition keep their keys, including
  composition-confirming Enter and Escape. Keyboard movement never loads another page implicitly,
  and searching/clearing leaves both active-session and start drafts intact.

- Older chronological history is reached with an explicit `Load older sessions` control, never
  implicit scrolling. It reports the number of server rows consumed out of the query total, exposes
  loading/retry/end states to keyboard and assistive technology, and sits below the chronological
  groups before Hidden. Search and explicit refresh restart at offset zero; loading older appends
  in server order. Curated, selected, and live-session hydration is deduplicated and chunked within
  the host route bounds; it can add visible rows but never advances the chronological cursor.

  Hydration and preservation failures keep the last confirmed union and recover automatically in a
  bounded, generation-owned window. Supplemental catalog reads do not create warning/retry tasks; a
  not-yet-materialized live row is expected and never resets loaded base pages. Initial/search and
  older-page failures stay beside their explicit navigation action. Foreground loading and failure
  states suppress the empty-result message until a successful empty response.

## Startup, welcome, and directory selection

- Opening the product follows a remembered user choice: resume the previous session or show a
  welcome page. Resume yields to any explicit open, create, or deselect intent that begins while
  the initial catalog is loading. Bootstrap or socket loss keeps the last confirmed surface where
  one exists and retries automatically instead of showing the interruption as a red operation
  error. Authentication failure means the host answered and opens the one-time browser-pairing
  surface. A network failure to the exact loopback origin means only that the host is not reachable
  (the browser cannot prove why): it names the address, `./inspire` recovery command, automatic
  retry, and manual retry without claiming that the service is certainly stopped.

  A later live-stream interruption preserves the last settled state and starts with the narrower
  reconnect explanation, then adopts the more specific bootstrap result. Settings and contextual
  Files/Changes/History load on demand within a stable shell and focus boundary. Loading, ready and
  failure keep the dialog/drawer owner, Close control and keyboard containment; resolving content
  does not restart shell entry animations. [[design-system]] owns loading geometry, delay, status
  and recovery presentation.

  Before React bootstraps, a validated browser-local cache may apply only the saved theme,
  palette, content text size, and reading width to prevent a wrong first paint; host preferences
  remain authoritative and immediately replace stale cache state. [[design-system]] owns PWA
  metadata: active Window Controls Overlay follows the workspace frame, ordinary tabs and
  standalone fallback use neutral hints, and installed icons keep their fixed neutral identity. The
  production origin is installable as a standalone PWA. Its service worker caches only the
  versioned application shell and same-origin static assets, never API, event, attachment or
  resource responses. The cached shell can present the host-aware states above but cannot start a
  local process; Pi/session capability still requires the loopback host and its authenticated API.

- The welcome page host-deselects any visible session before presenting the
  first-message/project-directory composer. The prior session then no longer owns topbar status,
  resources, attention acknowledgement, Escape, or delete protection, even if its idle worker
  stays warm. A collapsible recent-session list appears only when navigation is unavailable or
  collapsed, since expanded desktop navigation already owns that route. Recent sessions exclude
  hidden sessions/folders and show up to six entries in activity order. Recent and Hidden
  disclosure choices share the browser-tab-local navigation metadata store, initialized before
  first render; F5 and returning home preserve explicit choices. Search may temporarily reveal
  Hidden without overwriting that choice.

  A missing project directory offers the explicit creation path in [[session-continuity]]. An
  invalid or inaccessible directory instead shows its own retryable error and blocks Start, even
  when a model was chosen manually. Failed open/create operations stay in the navigation and start
  surfaces without replacing a transcript integrity error.

- The project directory can be typed or chosen through a host-side directory picker. The host
  process lists its own filesystem (`GET /api/host/dirs`, authenticated, session-independent), so
  over SSH forwards or remote deployments the browsed tree is always the machine sessions run on,
  and entry paths arrive joined with the host's own separators. Root discovery is host-owned:
  POSIX exposes `/`, while Windows enumerates assigned drive names without filesystem availability
  probes, so a user can cross from `C:\` to `D:\` without a nonexistent common parent.
  Availability is checked when the user enters a drive. Drive discovery loads independently of the
  current directory: a disconnected mapping, slow native query or failed root request cannot
  withhold a valid local listing or confirmation. Discovery failure offers typed-path guidance
  without turning a successful directory load into an error; late discovery belongs to the dialog
  lifetime, not a superseded directory request.

  An empty or relative starting point uses the Host home. Transient failures retry the requested
  starting path. A confirmed invalid or inaccessible starting path falls back to the Host home.
  The editable picker path wraps and grows with content and available width. Typed project paths expand
  Host-native `~`/`~/` (also `~\` on Windows) before browsing, model/file observations, explicit
  creation and session start. The browser machine's home, environment variables, globs and other
  users' homes are never expanded. Enter browses the typed path without selecting it. Use this
  directory validates an edited path against the Host before selection instead of choosing the old
  listing. Errors keep the draft; editing clears the error for retry. While browsing, the path is
  temporarily read-only but keeps keyboard focus, and stale or dismissed requests cannot select a
  directory. Navigation withdraws the old listing, while a reload of the same path and filter
  retains it during the read. If loading displaced list focus,
  completion focuses the first available folder (or list container) only while no newer control
  owns focus.

- The directory picker places an eye-icon `Show hidden folders` toggle button immediately after
  the `Choose project directory` heading, with an accessible label, tooltip, and `aria-pressed`
  state. It is keyboard-operable, off on each opening, and retained while navigating directories
  or drive roots. Unless `showHidden=1` is explicitly requested, the Host excludes dot-prefixed
  names on every platform, plus Windows Hidden attributes and macOS UF_HIDDEN flags. This is a
  visibility filter, not access control: a typed hidden path stays usable, and readable directory
  links stay navigable. Native attribute inspection is bounded and nonrecursive; its failure is
  reported rather than silently showing hidden entries, and explicit show-hidden browsing bypasses
  that inspection.

  Rapid visibility/navigation changes and dismissal retire old request writebacks; pending or
  failed loads cannot confirm an earlier directory as the requested destination.

## Feedback scope

- Session selection keeps its pending-navigation and send/deletion safety guards without
  displaying the agent's working animation. Fast opens stay quiet; after 800ms, the target row's
  age is temporarily replaced by `Opening…`. Completion or failure clears that feedback, while
  genuine agent activity keeps its existing status glyph. Pending navigation keeps normal label
  opacity instead of briefly dimming the row.
- Recover internal read state automatically while keeping confirmed content. Catalog backfill,
  History revalidation, snapshot refresh and file probes use bounded, ownership-checked retry;
  branch commands and prompts with uncertain acceptance are never automatically replayed.
- Top banners describe a condition that affects the workspace: persistent loss of
  synchronization, an unavailable address, projection failure, or a recoverable ownership
  conflict. A normal stream interruption starts with the existing topbar reconnect status and gains
  a banner only after ten seconds; a more specific reachability diagnosis may appear immediately.
  A single transient background snapshot failure does not become a global warning; persistent
  failure can after bounded automatic recovery. Banner actions retry the relevant read, reconnect,
  or recover that condition. A successful authoritative observation clears a refresh warning; a
  cached-state acknowledgement does so only when no projection problem remains. An unrelated
  successful operation does not clear a synchronization warning.
- Operation failures belong beside an available retry surface, such as deletion confirmation, an
  extension question, a form, or a resource pane. Otherwise they use the existing notification
  stack: send, Stop, Pending clear, and prompt-history failures do not overwrite the workspace
  banner. Location expresses scope, not severity. An extension reply error stays inside the same
  request's dialog, with entered content and retry/cancel controls intact; expiry, a newer request,
  selection, or transport replacement cannot inherit it.
- Expected lifecycle transitions do not report obsolete background reads as failures.
  [[session-deletion]] owns the deletion boundary; real deletion failure and authentication loss
  stay visible. [[design-system]] owns the shared floating notice stack, placement, scrolling and
  dwell across Welcome and conversation views.

## Session-owned controls and command palette

- [[composer]] owns delivery states, per-session drafts and prompt-result ownership. A session
  switch restores its draft and closes session-owned transient surfaces — project-file picker, drop
  state, model/thinking popovers, and completions — before the new owner paints.

- Visible controls make core operations discoverable; keyboard shortcuts and a command interface
  accelerate the same operations without replacing them. Visible, keyboard and palette actions
  share each operation's eligibility and execution path.

  The optional command palette opens from the topbar or Ctrl/Command+K at every width, with no
  duplicate sidebar entry. It starts with a compact set of useful actions and recent sessions, not
  the full preference/command inventory. Search reaches existing Files, Changes, History, Terminal,
  terminal creation/control, return-to-latest-branch, navigation, lifecycle, and preference
  actions. Exact titles and aliases rank before prefixes and fuzzy matches across categories;
  descriptions add relevance without overwhelming command-name matches. Aliases, including
  built-in navigation names, share one destination, and terminal-only entries identify their
  limitation before selection. Session-bound actions require a selected session rather than
  implying first-message support.

  Find a session and `/resume` focus the full Host catalog search in navigation, not the palette's
  already-loaded session subset. The destination expands desktop navigation or opens its narrow
  drawer, works from the start surface, and preserves both active and start drafts. Recent session
  shortcuts remain direct palette actions.

  On a narrow workbench, action dialogs and extension questions share the existing transient
  inspection history owner. Browser Back cancels the active extension question before closing the
  surface underneath it. A question awaiting its native response, or a failed cancellation, keeps
  its layer for feedback and retry. Explicit dismissal consumes its entry without leaving an empty
  return stop. Drafts stay with their session; no routes are added.

  Existing graphical actions open their own controls. Commands needing prompt review or arguments
  use the transient preparation boundary in [[composer]], not a second persistent editor or queue.
  The palette does not create a second queue-inspection surface for immutable Pi-owned queued
  input. Its command filter and session rename value are independent: entering rename pre-fills
  the current presentation title, Escape returns to the original filter, and an unedited Enter
  never promotes a fallback title into Pi metadata. Renames are latest-request-wins per session,
  and an older completion cannot close a subsequently reopened rename editor.

- Keyboard shortcuts open one focus-contained, scrollable browser help dialog. It reflects the
  chosen desktop send chord, touch-first Return and IME boundaries, completion/history, palette and
  picker keys, conversation search, and scoped project-terminal shortcuts. Each keycap shows a
  complete shortcut chord, with `+` for simultaneous presses. `Ctrl/⌘` denotes only the platform
  modifier substitution; different action keys never share an internal slash (`C/V`, `M/P`, etc.).
  Paired operations have separate complete keycaps in the same row. Navigation followed by
  confirmation uses explicit chord groups separated by a middle dot. Keycaps wrap at group/chord
  boundaries as space permits and use conventional `Esc` and `PgUp/PgDn` key names. Keycap
  styling, grouping and send-key preferences are unchanged.

  Model/thinking cycling uses the browser-platform bindings in [[model-settings]]; Option text, IME
  and AltGraph remain native. Primary K/B/period shortcuts require exactly Ctrl or Command, without
  Alt/Shift, leaving shifted browser chords available.

  `/changelog` opens the help surface in release-note mode, showing the installed Pi version's
  shipped changelog entry with loading, failure, and retry states. It is not an update/settings
  destination and performs no network lookup. Markdown uses the existing deferred safe renderer;
  documentation links are explicitly current upstream links, not arbitrary Host-file navigation.
