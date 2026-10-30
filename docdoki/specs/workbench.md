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
  - src/components/ContextSplitBody.tsx
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
  - tests/web/update-controller.test.ts
  - tests/web/modal-focus.test.tsx
  - tests/web/overlay-and-palette.test.tsx
  - tests/web/command-ux.test.tsx
  - tests/browser/command-ux.spec.ts
  - tests/web/theme-init.test.ts
  - tests/web/nav.test.ts
  - tests/web/nav-render.test.tsx
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

- Project and session navigation remains visible at the left by default and gives every session one
  canonical position: individually pinned sessions occupy one global top section, then pinned
  project folders and remaining folders grouped by working directory with newest activity first,
  while a Hidden group contains individually hidden sessions and complete hidden folders last.
  Runtime state appears only on each canonical row's dot: working is yellow, unseen completion
  green, unseen failure red, and recovery warning-ringed. This preserves location memory without
  duplicating a session into a second runtime-derived group; Hidden rows retain the same dots when
  expanded. The conversation stays dominant in the center, and the right contextual region opens
  only when requested. Its Changes selector shows the same authoritative total as the topbar,
  capped visually at `99+` and omitted when the header is too narrow; the tooltip retains the exact
  count. On narrow screens it uses the full-width modal drawer specified in [[workspace-layout]].

- Navigation owns New session, search and its collapse/expand controls. [[design-system]] defines
  their shared alignment and the installed-window header variant. The desktop rail's leading
  control expands navigation and its separate plus button starts a session; the conversation
  header does not duplicate that toggle. Keyboard collapse/expand from within navigation restores
  focus to the corresponding sidebar toggle, while the same shortcut from the editor preserves
  editor focus. On narrow screens there is no rail: the topbar opens the full modal drawer, whose
  header closes it. Closing or changing viewport does not overwrite the desktop collapse state.

- Pinning and hiding are reversible navigation metadata that never touch Pi's session storage, and
  they are mutually exclusive: hiding a session drops its pin, restoring it returns it to its
  folder, and each change travels as a single preference patch so the two identity lists cannot
  disagree. Folder pins use the exact cwd identity that already defines groups and their collapse
  state.

- Desktop session rows use two compact lines: the activity mark precedes the title on the first
  line, right-aligned inside the same 16px icon slot and 8px label gap as folder rows. The status
  mark renders at 10px, scaled about its painted right edge and vertical centre without moving
  the slot, text axis or selection marker. The text axis remains reserved when no status is present;
  age aligns with the title. Cross-project metadata
  follows age on that quieter second line. Hidden keeps enough leading gutter to separate status
  from its selection marker.
  Pin/Hide or Restore/Delete appear at the trailing edge on hover or keyboard focus,
  without hiding metadata or taking width from the title. Ordinary pointer rows are 44px high;
  coarse desktop rows retain visible 36px actions. Narrow session layouts remain unchanged.
  Folder headers retain their label tier, persistent pin state and trailing session count.
  Desktop New/Search, folder headers and session-row surfaces share the same outer inset;
  their internal icon/text axes remain stable. Hidden's full-width dock header remains distinct
  from its inset contents; its root folders and row surfaces use the normal project axes without
  an extra section-wide indent. Independent hidden sessions stay at that root text axis;
  grouped sessions retain the compact desktop layout rather than adding another 20px indent.
  The exact timestamp and message count stay in tooltips. On phone-width layouts or without
  hover the actions remain visible beside the age. Pin and Hide stay directly accessible,
  not behind an overflow menu.

- Project groups expose native expand/collapse controls across the header's main button. A single
  open/closed folder icon conveys the displayed state without a separate disclosure arrow, leaving
  more width for the folder name. The button retains its name and `aria-expanded` state for keyboard
  and assistive-technology use. A collapsed group containing the visible
  session carries the active highlight on its header, and active search results remain visible
  regardless of saved collapse state. Hidden is a bottom curation drawer outside the session list's
  scroll area. Its neutral 44px header leaves space around the label and aligned icons, with the
  count at the trailing edge before the disclosure indicator. The header precedes its content; Hidden's
  independently scrolling body is bounded to leave room for ordinary navigation. Both scrollports
  retain enough height for complete rows in short windows, including safe-area insets. When those
  minimums cannot fit alongside New/Search and the drawer header, navigation itself scrolls rather
  than compressing a list into a sliver. Opening Hidden reveals its body without transferring focus;
  normal-height navigation retains independent list scrolling and its existing spacing. Project identity
  remains on cross-project Hidden rows as quiet text rather than a filled badge. On phone-width or
  non-hover layouts, all cross-project rows (Pinned, search and Hidden) place project and age beneath
  the title so persistent actions do not
  crowd it. Selection and search highlights cover the whole row, including its action area.
  The drawer opens on demand, starts closed
  again, and search reveals matching hidden sessions inside it instead of returning them to their
  folders. Ordinary session-entry surfaces, including Welcome recents and the command palette's
  recents/search, share the hidden-session/project filter. Hidden sessions remain available through
  the explicit Hidden drawer rather than reappearing as ordinary recommendations.
  With no hidden results the drawer is absent. Ordinary rows keep Pin and Hide; Hidden rows
  reuse those same two action slots for Restore and Delete, making individual deletion a deliberate
  second-stage action rather than a third always-present icon. Every hidden session, including a
  child of a hidden folder, has both Restore and Delete in those fixed columns. Restoring a child
  resolves the complete folder through the catalog, restores only that session and keeps all siblings
  individually hidden. A failed lookup or newer Hidden edits leave the prior curation intact. Folder
  headers have the same Restore/Delete columns. Folder Delete confirms the count and full path,
  and clears only that complete hidden folder; other hidden sessions and folders are unchanged.

  Clear Hidden is a persistent header icon action, between the count and disclosure, with its own
  accessible name and click target. The count and controls retain their positions when the drawer
  opens or closes. Independent hidden session titles start farther left than folder contents, so
  a row following a folder does not appear to be its child. Complete hidden folders retain their
  own nested indentation. Clear does not consume a content row. It clears the entire drawer
  through one count-bearing confirmation: it includes both individually hidden sessions and every
  session in complete hidden folders, never only one child folder. It is unavailable while search or curation hydration can
  show only a partial selection, and while any target is opening, working in Inspire, or conflicted.
  Viewing an idle target or observing it in an external Pi terminal does not block deletion;
  [[session-deletion]] owns idle-worker retirement and the contextual terminal consequence.
  A folder-level deletion applies the same conditions to that folder, not to unrelated targets elsewhere in Hidden.
  Session deletion leaves project files and project folders unchanged.

### Search and pagination

- Sidebar search reaches session name, cwd, ID and complete retained user/assistant text through
  the Host catalog. [[session-continuity]] owns query syntax, matching and source authority;
  [[design-system]] owns visible match emphasis. Search uses the existing sidebar without another
  panel or filter toolbar.

  Search reveals the immediate parent beside a project group when that parent has a visible
  token/phrase match but the project basename does not. Existing context for colliding basenames
  remains. Both contexts use `project @parent`; the `@` marker uses secondary text styling and is
  excluded from match emphasis. Cross-project session locations have no `@` prefix: they normally
  show the project basename, expanding to `parent/project` only when the parent matches and neither
  title nor basename does. That expansion temporarily replaces age metadata; ordinary browsing
  restores basename and age. Regex results have no match emphasis. Row layout and quiet location
  styling follow the navigation rules above.

  Focusing an empty search input does not highlight or open a session. Unmodified Up/Down starts
  deliberate result navigation, including with an empty query; a non-empty query defaults to its first
  result. Clearing the query or leaving and refocusing an empty input resets that transient highlight.
  While the search input owns focus, Up/Down follows the same project/Pin/Hidden order as navigation;
  Enter opens only the highlighted identity. Focus stays in the
  input, the highlighted row scrolls into view, and a live status names the choice for assistive
  technology. Highlighting is distinct from the opened session. The same identity survives page
  append, same-query refresh, and curation reordering; a changed query cannot open an old result
  while its response is pending. Modifier-based text editing and IME composition keep their keys,
  including composition-confirming Enter and Escape. Keyboard movement never loads another page
  implicitly, and searching/clearing leaves both active-session and start drafts intact.

- Older chronological history is reached with an explicit `Load older sessions` control, never
  implicit scrolling. It reports the number of server rows consumed out of the query total, exposes
  loading/retry/end states to keyboard and assistive technology, and sits below the chronological
  groups before Hidden. Search and explicit refresh restart at offset zero; loading older appends in
  server order. Curated, selected, and live-session hydration is deduplicated and chunked within the
  host route bounds; it can add visible rows but never advances the chronological cursor.

  Hydration and preservation failures retain the last confirmed union and recover automatically in
  a bounded, generation-owned window. Supplemental catalog reads do not create warning/retry tasks;
  a not-yet-materialized live row is expected and never resets loaded base pages. Initial/search and
  older-page failures stay beside their explicit navigation action. Foreground loading and failure
  states suppress the empty-result message until a successful empty response.

## Startup, welcome, and directory selection

- Opening the product follows a remembered user choice: resume the previous session or show a
  welcome page. Resume yields to any explicit open, create, or deselect intent that begins while the
  initial catalog is loading. Bootstrap or socket loss keeps the last confirmed surface where one
  exists and retries automatically instead of presenting the interruption as a red operation error.
  Authentication failure means the host answered and opens the one-time browser-pairing surface; a
  network failure to the exact loopback origin means only that the host is not reachable (the
  browser cannot prove why), and names the address, `./inspire` recovery command, automatic retry,
  and manual retry without claiming that the service is certainly stopped.

  A later live-stream interruption preserves the last settled state and starts with the narrower
  reconnect explanation, then adopts the more specific bootstrap result. Settings and contextual
  Files/Changes/History load on demand within a stable shell and focus boundary. Loading, ready and
  failure preserve the dialog/drawer owner, Close control and keyboard containment; resolving content
  does not restart shell entry animations. [[design-system]] owns loading geometry, delay, status and
  recovery presentation. Before React bootstraps, a validated browser-local
  cache may apply only the saved theme, palette, content text size, and reading width to prevent a
  wrong first paint; host preferences remain authoritative and immediately replace stale cache
  state. [[design-system]] owns PWA metadata: active Window Controls Overlay follows the workspace
  frame, while ordinary tabs and standalone fallback use neutral hints. Installed icons retain
  their fixed neutral identity. The production origin is installable as a standalone PWA. Its service
  worker caches only the versioned application shell and same-origin static assets, never API, event,
  attachment or resource responses.

  The cached shell can present those host-aware states, but cannot start a local process; Pi/session
  capability still requires the loopback host and its authenticated API.

- The welcome page host-deselects any visible session before presenting the
  first-message/project-directory composer, so the prior session no longer owns topbar status,
  resources, attention acknowledgement, Escape, or delete protection even if its idle worker remains
  warm. A collapsible recent-session list appears only when navigation is unavailable or collapsed;
  expanded desktop navigation already owns that route and is not duplicated. Recent sessions exclude
  hidden sessions/folders and show up to six entries in activity order. Recent and Hidden disclosure
  choices share the browser-tab-local navigation metadata store, initialized before first render;
  F5 and returning home preserve explicit choices. Search may temporarily reveal Hidden without
  overwriting that choice. A missing project
  directory offers the explicit creation path in [[session-continuity]]. An invalid or inaccessible
  directory instead shows its own retryable error and blocks Start, including when a model was
  chosen manually. Failed open/create operations remain in the navigation and start surfaces
  without replacing a transcript integrity error.

- The project directory can be typed or chosen through a host-side directory picker: the host
  process lists its own filesystem (`GET /api/host/dirs`, authenticated,
  session-independent), so over SSH forwards or remote deployments the browsed tree is always the
  machine sessions run on, and entry paths arrive joined with the host's own separators. Root
  discovery is host-owned too: POSIX exposes `/`, while Windows enumerates assigned drive names
  without filesystem availability probes, so a user can cross from `C:\` to `D:\` without inventing
  a nonexistent common parent. Availability is checked when the user enters a drive. Drive discovery
  loads independently of the current directory: a disconnected mapping, slow native query or failed
  root request cannot withhold a valid local listing or confirmation. Failure offers typed-path
  guidance without turning a successful directory load into an error; late discovery belongs to
  the dialog lifetime, not a superseded directory request.
  A missing or relative starting point falls back to the host home. The picker path is editable,
  automatically wraps long text and grows/shrinks with content and available width. Typed project
  paths expand Host-native `~`/`~/` (also `~\` on Windows) before browsing, model/file observations,
  explicit creation and session start. This never expands the browser machine's home, environment
  variables, globs or other users' homes. Enter browses the typed path without selecting it.
  Use this directory validates an edited path
  against the Host before selection instead of choosing the old listing. Errors retain the draft;
  editing clears the error for retry. While browsing, the path is temporarily read-only but retains
  keyboard focus, and stale or dismissed requests cannot select a directory. Navigation withdraws
  the old listing immediately. If list focus was displaced by loading, completion focuses the first
  available folder (or list container) only while no newer control owns focus.

- The directory picker places an eye-icon `Show hidden folders` toggle button immediately after
  the `Choose project directory` heading, with an accessible label, tooltip, and `aria-pressed`
  state. It is keyboard-operable, off on each opening, and retained while navigating directories
  or drive roots. The Host excludes
  dot-prefixed names on every platform, plus Windows Hidden attributes and macOS UF_HIDDEN flags,
  unless `showHidden=1` is explicitly requested. This is a visibility filter, not access control: a
  typed hidden path remains usable, and readable directory links remain navigable. Native attribute
  inspection is bounded and nonrecursive; failure is reported rather than silently showing hidden
  entries, while explicit show-hidden browsing bypasses that inspection.

  Rapid visibility/navigation changes and dismissal retire old request writebacks; pending or failed
  loads cannot confirm an earlier directory as the requested destination.

## Feedback scope

- Session selection retains its pending-navigation and send/deletion safety guards without
  displaying the agent's working animation. Fast opens stay quiet; after 800ms, the target row's
  age is temporarily replaced by `Opening…`. Completion or failure clears that feedback, while
  genuine agent activity keeps its existing status glyph. Pending navigation retains normal label
  opacity instead of briefly dimming the row on every fast open.
- Recover internal read state automatically while retaining confirmed content. Catalog backfill,
  History revalidation, snapshot refresh and file probes use bounded, ownership-checked retry;
  branch commands and prompts with uncertain acceptance are never automatically replayed.
- Top banners describe a condition that affects the workspace: persistent loss of synchronization,
  an unavailable address, projection failure, or a recoverable ownership conflict. A normal stream
  interruption starts with the existing topbar reconnect status; it gains a banner only after ten
  seconds. A more specific reachability diagnosis may appear immediately. A single transient
  background snapshot failure does not become a global warning; persistent failure can do so after
  bounded automatic recovery. Banner actions retry the relevant read, reconnect, or recover that
  condition. A successful authoritative observation clears a refresh warning; a cached-state acknowledgement does so only when no projection
  problem remains. An unrelated successful operation does not clear a synchronization warning.
- Operation failures belong beside an available retry surface, such as deletion confirmation,
  an extension question, a form, or a resource pane. Otherwise they use the existing notification
  stack: send, Stop, Pending clear, and prompt-history failures do not overwrite the workspace
  banner. Location expresses scope, not severity. An extension reply error remains inside the
  same request's dialog, with entered content and retry/cancel controls intact; expiry, a newer
  request, selection, or transport replacement cannot inherit it.
- Expected lifecycle transitions do not report obsolete background reads as failures.
  [[session-deletion]] owns the deletion boundary; real deletion failure and authentication loss
  remain visible. [[design-system]] owns the shared floating notice stack, placement, scrolling and
  dwell across Welcome and conversation views.

## Session-owned controls and command palette

- [[composer]] owns delivery states, per-session drafts and prompt-result ownership. A session switch
  restores its draft and closes session-owned transient surfaces — project-file picker, drop state, model/thinking
  popovers, and completions — before the new owner paints.

- Visible controls make core operations discoverable while keyboard shortcuts and a command
  interface accelerate the same operations instead of replacing them. The optional command palette
  opens from the topbar or Ctrl/Command+K at every width, without a duplicate sidebar entry. It
  starts with a compact set of useful actions and recent sessions, not the full preference/command
  inventory. Search reaches existing Files, Changes, History, Terminal, terminal creation/control,
  return-to-latest-branch, navigation, lifecycle, and preference actions. Exact titles and aliases
  rank before prefixes and fuzzy matches across categories; descriptions add relevance without
  overwhelming command-name matches. Aliases share one destination, including built-in navigation
  names, and terminal-only entries identify their limitation before selection. Session-bound actions
  require a selected session rather than implying first-message support.

  Find a session and `/resume` focus the existing full Host catalog search in navigation, not the
  palette's already-loaded session subset. The destination expands desktop navigation or opens its
  narrow drawer, works from the start surface, and preserves both active and start drafts. Recent
  session shortcuts remain direct palette actions.

  On a narrow workbench, action dialogs and extension questions share the existing transient
  inspection history owner. Browser Back cancels the active extension question before closing
  the surface underneath it. A question awaiting its native response, or a failed cancellation,
  retains its layer for feedback and retry. Explicit dismissal consumes its entry rather than
  leaving an empty return stop. Drafts stay with their session; no routes are added.

  Existing graphical actions open their own controls. Commands needing prompt review or arguments
  use the transient preparation boundary in [[composer]], not a second persistent editor or queue.
  The palette does not create a second queue-inspection surface for immutable Pi-owned queued input.
  Its command filter and session
  rename value are independent: entering rename pre-fills the current presentation title, Escape
  returns to the original filter, and an unedited Enter never promotes a fallback title into Pi
  metadata. Renames are latest-request-wins per session, and an older completion cannot close a
  subsequently reopened rename editor.

  Visible, keyboard and palette actions share each operation's eligibility and execution path.

- Keyboard shortcuts open one focus-contained, scrollable browser help dialog. It reflects the
  chosen desktop send chord, touch-first Return and IME boundaries, completion/history, palette and
  picker keys, conversation search, and scoped project-terminal shortcuts. Each keycap shows a
  complete shortcut chord, with `+` for simultaneous presses. `Ctrl/⌘` denotes only the platform
  modifier substitution; different action keys never share an internal slash (`C/V`, `M/P`, etc.).
  Paired operations have separate complete keycaps in the same row. Navigation followed by
  confirmation uses explicit chord groups separated by a middle dot. Keycaps wrap at group/chord
  boundaries as space permits and use conventional `Esc` and `PgUp/PgDn` key names.
  Model/thinking cycling uses the browser-platform bindings in [[model-settings]]; Option text,
  IME and AltGraph remain native. Primary K/B/period shortcuts require exactly Ctrl or Command,
  without Alt/Shift, leaving shifted browser chords available. Keycap styling, grouping and
  send-key preferences remain unchanged. `/changelog` opens that
  help surface in release-note mode, showing the installed Pi version's shipped changelog entry
  with loading, failure, and retry states. It is not an update/settings destination and performs no
  network lookup. Markdown follows the existing deferred safe renderer; documentation links are
  explicitly current upstream links, not arbitrary Host-file navigation.
