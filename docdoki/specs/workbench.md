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
  - src/components/Welcome.tsx
  - src/components/DirectoryPicker.tsx
  - src/components/CommandPalette.tsx
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
  - scripts/write-build-stamp.mjs
  - tests/server/app.test.ts
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
  - tests/web/composer.test.tsx
  - tests/web/notices.test.tsx
  - tests/web/settings-navigation.test.tsx
  - tests/web/settings-loading.test.tsx
  - tests/browser/loading-states.spec.ts
  - tests/web/update-controller.test.ts
  - tests/web/modal-focus.test.tsx
  - tests/web/overlay-and-palette.test.tsx
  - tests/web/theme-init.test.ts
  - tests/web/nav.test.ts
  - tests/web/nav-render.test.tsx
  - tests/web/workspace-controller.test.ts
  - tests/web/pane-resize.test.tsx
  - tests/web/branch-tree.test.tsx
---

# Workbench shell

## Goal

Give daily Pi work a coherent graphical home that starts focused and can expand toward a scientific workbench.

## Contract map

- [[workspace-layout]] — responsive reading geometry, topbar identity, Git observation, and contextual modes.
- [[interface-preferences]] — Settings, ordered preference writes, update observations, and completion attention.
- [[host-lifecycle]] — atomic browser-build publication and retained executable assets.

## Checks

### Canonical project and session navigation

- Project and session navigation remains visible at the left by default and gives every session one
  canonical position: individually pinned sessions occupy one global top section, then pinned
  project folders and remaining folders grouped by working directory with newest activity first,
  while a Hidden group contains individually hidden sessions and complete hidden folders last.
  Runtime state appears only on each canonical row's dot: working is yellow, unseen completion
  green, unseen failure red, and recovery warning-ringed. This preserves location memory without
  duplicating a session into a second runtime-derived group; Hidden rows retain the same dots when
  expanded. The conversation stays dominant in the center, and the right contextual region opens
  only when requested.

- Pinning and hiding are reversible navigation metadata that never touch Pi's session storage, and
  they are mutually exclusive: hiding a session drops its pin, restoring it returns it to its
  folder, and each change travels as a single preference patch so the two identity lists cannot
  disagree. Folder pins use the exact cwd identity that already defines groups and their collapse
  state.

- An ordinary session row is one dense line carrying a single number: its title at the left, and at
  the right a compact activity age in a fixed column, preceded by the owning project only where a
  section crosses folders. Folder headers use the next legibility tier for their label and
  persistent pin state, while putting their smaller session count in that same right-hand column, so
  the panel reads down one rule. The exact timestamp and the message count stay in tooltips rather
  than becoming a second number. The pin and hide actions take over that column on hover or focus
  without moving anything, and where there is no hover to reveal them they take their own space
  beside the age.

- Project groups expose native expand/collapse controls; a collapsed group containing the visible
  session carries the active highlight on its header, and active search results remain visible
  regardless of saved collapse state. Hidden is a curation drawer rather than a browsing group: it
  opens on demand, starts closed again, and search reveals matching hidden sessions inside it
  instead of returning them to their folders. Ordinary rows keep Pin and Hide; Hidden rows reuse
  those same two action slots for Restore and Delete, making individual deletion a deliberate
  second-stage action rather than a third always-present icon.

  The Hidden header’s destructive action clears the entire drawer through one count-bearing
  confirmation: it includes both individually hidden sessions and every session in complete hidden
  folders, never only one child folder. It is unavailable while search or curation hydration can
  show only a partial selection, and while any target is selected, opening, working, or conflicted.
  Session deletion leaves project files and project folders unchanged.

- Older chronological history is reached with an explicit `Load older sessions` control, never
  implicit scrolling. It reports the number of server rows consumed out of the query total, exposes
  loading/retry/end states to keyboard and assistive technology, and sits below the chronological
  groups before Hidden. Search and explicit refresh restart at offset zero; loading older appends in
  server order. Curated, selected, and live-session hydration is deduplicated and chunked within the
  host route bounds; it can add visible rows but never advances the chronological cursor.

  Hydration or preservation failure retains the last confirmed union, identifies the operation
  truthfully, and retries that same operation; a standalone live-row failure is labeled session
  hydration and never resets already loaded base pages.

### Startup, welcome, and directory selection

- Opening the product follows a remembered user choice: resume the previous session or show a
  welcome page. Resume yields to any explicit open, create, or deselect intent that begins while the
  initial catalog is loading. Bootstrap or socket loss keeps the last confirmed surface where one
  exists and retries automatically instead of presenting the interruption as a red operation error.
  Authentication failure means the host answered and opens the one-time browser-pairing surface; a
  network failure to the exact loopback origin means only that the host is not reachable (the
  browser cannot prove why), and names the address, `./inspire` recovery command, automatic retry,
  and manual retry without claiming that the service is certainly stopped.

  A later live-stream interruption preserves the last settled state and starts with the narrower
  reconnect explanation, then adopts the more specific bootstrap result. Settings and the contextual
  Files/Changes/History implementation remain separate on-demand JavaScript chunks; their loading
  placeholders already own the same dialog/focus boundary, so reducing the critical shell never
  exposes background shortcuts or an unclosable narrow drawer. Settings keeps the identical overlay,
  dialog, header, and focus owner mounted outside its deferred body boundary through loading, ready,
  and failure states; resolving its first import must not replay whole-overlay or dialog entrance
  animations.

  Its loading body reserves the responsive sidebar, card, and footer geometry with static decorative
  placeholders and one concise status; it offers no placeholder controls. Context and History use
  the same styled pane-state component for waiting, empty, and unavailable views, with alert
  semantics and real recovery buttons on failure. Before React bootstraps, a validated browser-local
  cache may apply only the saved theme, palette, content text size, and reading width to prevent a
  wrong first paint; host preferences remain authoritative and immediately replace stale cache
  state. PWA title-bar metadata follows resolved light/dark mode using the palette-independent
  neutrals in [[design-system]], and installed icons use a fixed neutral mark rather than a
  runtime palette. The production origin is installable as a standalone PWA: its service worker caches only
  the versioned application shell and same-origin static assets, never API, event, attachment, or
  resource responses.

  The cached shell can present those host-aware states, but cannot start a local process; Pi/session
  capability still requires the loopback host and its authenticated API.

- The welcome page host-deselects any visible session before presenting the
  first-message/project-directory composer, so the prior session no longer owns topbar status,
  resources, attention acknowledgement, Escape, or delete protection even if its idle worker remains
  warm. A collapsible recent-session list appears only when navigation is unavailable or collapsed;
  expanded desktop navigation already owns that route and is not duplicated. A missing project
  directory produces a non-blocking warning notice. Failed open/create operations remain in the
  navigation and start surfaces without replacing a transcript integrity error.

- The project directory can be typed or chosen through a host-side directory picker: the host
  process lists its own filesystem (`GET /api/host/dirs`, bearer-token guarded,
  session-independent), so over SSH forwards or remote deployments the browsed tree is always the
  machine sessions run on, and entry paths arrive joined with the host's own separators. Root
  discovery is host-owned too: POSIX exposes `/`, while Windows exposes every currently readable
  drive root so a user can cross from `C:\` to `D:\` without inventing a nonexistent common parent.
  A missing or relative starting point falls back to the host home.

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

### Session-owned controls and command palette

- The composer and host share one busy-state authority for `running`, `retrying`, `compacting`, and
  `queued`. Busy work presents steer, follow-up, and abort controls, including while input is
  queued; a prompt result may update only its sending session’s composer partition and may touch the
  visible global error only while that session remains visible. A session switch restores its draft
  and closes session-owned transient surfaces — project-file picker, drop state, model/thinking
  popovers, and completions — before the new owner paints.

- Visible controls make core operations discoverable while keyboard shortcuts and a command
  interface accelerate the same operations instead of replacing them. The command palette groups
  existing Files, Changes, History, Terminal, terminal creation/control, and return-to-latest-branch
  actions alongside navigation, lifecycle, and preference controls; it does not create a second
  queue-inspection surface for immutable Pi-owned queued input. Its command filter and session
  rename value are independent: entering rename pre-fills the current presentation title, Escape
  returns to the original filter, and an unedited Enter never promotes a fallback title into Pi
  metadata. Renames are latest-request-wins per session, and an older completion cannot close a
  subsequently reopened rename editor.

  These action entries invoke existing store facades directly; a registry is warranted only when
  distinct visible, keyboard, and palette surfaces begin to duplicate one operation's capability or
  eligibility logic.

## Implementation evidence

[[hidden-project-directories]] records the hidden-folder rule, native inspection boundary, API/picker regressions, and platform verification limits.

[[portable-file-lock-races]] records the cross-Host locking boundary used by preference patches, launcher lifecycle, and web-build publication.

`tests/browser/loading-states.spec.ts` holds the actual deferred Settings/Context chunks and History request to verify styled loading, stable desktop/narrow Settings shell and sidebar geometry, decorative-only placeholders, reduced motion, accessibility, dismissal, focus restoration, and failed-import reload recovery. Network fault injection blocks the service worker in that spec only so its cache cannot bypass the test routes. The loading-state repair passed Node 22 `npm run check` and all 29 production-build Chromium checks; desktop-light and narrow-dark screenshots were also inspected. Files/Changes previews and terminal loading already had owned state styles and were left intact.

## Non-goals

- The first release does not need to populate every future workbench surface.
- The interface does not reproduce a terminal layout or an existing reference application pixel for pixel.
