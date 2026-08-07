---
purpose: The product opens as a conversation-centered, collapsible workbench whose surrounding regions can grow without replacing the initial interface.
covers:
  - index.html
  - public/manifest.webmanifest
  - public/service-worker.js
  - public/app-icon.svg
  - public/app-icon-maskable.svg
  - shared/contracts.ts
  - server/app.ts
  - src/api.ts
  - src/main.tsx
  - src/store.ts
  - src/App.tsx
  - src/components/Nav.tsx
  - src/components/Welcome.tsx
  - src/components/DirectoryPicker.tsx
  - src/components/CommandPalette.tsx
  - src/components/Settings.tsx
  - src/components/ResourcesPane.tsx
  - src/components/PaneResizeHandle.tsx
  - src/components/SessionDeleteDialog.tsx
  - src/use-modal-focus.ts
  - server/host-dirs.ts
  - src/styles.css
  - tests/server/app.test.ts
  - tests/server/host-dirs.test.ts
  - tests/web/app.test.tsx
  - tests/web/modal-focus.test.tsx
  - tests/web/nav.test.ts
  - tests/web/nav-render.test.tsx
  - tests/web/pane-resize.test.tsx
---

# Workbench shell

## Goal

Give daily Pi work a coherent graphical home that starts focused and can expand toward a scientific workbench.

## Checks

- The primary desktop layout provides stable regions for project/session navigation, conversation, and contextual work.
- Project and session navigation remains visible at the left by default and files every session into exactly one section, in order: individually pinned sessions in one global top section, pinned project folders, the remaining folders grouped by working directory with newest activity first, and a Hidden group containing individually hidden sessions and complete hidden folders last. The conversation stays dominant in the center, and the right contextual region opens only when requested.
- Pinning and hiding are reversible navigation metadata that never touch Pi's session storage, and they are mutually exclusive: hiding a session drops its pin, restoring it returns it to its folder, and each change travels as a single preference patch so the two identity lists cannot disagree. Folder pins use the exact cwd identity that already defines groups and their collapse state.
- An ordinary session row is one dense line carrying a single number: its title at the left, and at the right a compact activity age in a fixed column, preceded by the owning project only where a section crosses folders. Folder headers use the next legibility tier for their label and persistent pin state, while putting their smaller session count in that same right-hand column, so the panel reads down one rule. The exact timestamp and the message count stay in tooltips rather than becoming a second number. The pin and hide actions take over that column on hover or focus without moving anything, and where there is no hover to reveal them they take their own space beside the age.
- Project groups expose native expand/collapse controls; a collapsed group containing the visible session carries the active highlight on its header, and active search results remain visible regardless of saved collapse state. Hidden is a curation drawer rather than a browsing group: it opens on demand, starts closed again, and search reveals matching hidden sessions inside it instead of returning them to their folders. Ordinary rows keep Pin and Hide; Hidden rows reuse those same two action slots for Restore and Delete, making deletion a deliberate second-stage action rather than a third always-present icon. Delete opens an explicit destructive confirmation and stays disabled for the selected session or known active work.
- Older chronological history is reached with an explicit `Load older sessions` control, never implicit scrolling. It reports the number of server rows consumed out of the query total, exposes loading/retry/end states to keyboard and assistive technology, and sits below the chronological groups before Hidden. Search and explicit refresh restart at offset zero; loading older appends in server order. Curated, selected, and live-session hydration is deduplicated and chunked within the host route bounds; it can add visible rows but never advances the chronological cursor. Hydration or preservation failure retains the last confirmed union, identifies the operation truthfully, and retries that same operation; a standalone live-row failure is labeled session hydration and never resets already loaded base pages.
- The navigation column’s lower half offers a collapsible workspace explorer over the visible session’s project index; its rows open the same session-bound preview surface as conversation references.
- The topbar owns session identity — an explicit Pi name is the rename value, while an unnamed conversation presents its normalized first prompt (or `New session` before any prompt) without promoting that fallback into session metadata or OS-visible titles. The heading truncates responsively at its available width. Beside it, the project location appears as folder name or full path per a global preference, and clicking copies the absolute path without shifting layout. Runtime and extension status capsules remain in the leading cluster immediately after identity, while actions stay fixed at the right: long status text ellipsizes with its full value available on hover, identity yields first, and no supported center width permits the clusters to overlap. Rename editing is owned by the session whose heading opened it; a switch cancels that editor, the submit carries the explicit session id rather than reading a newer visible selection, and a rejected rename leaves the current identity intact while emitting a non-blocking warning notice.
- The navigation and contextual regions can collapse so the conversation can use the available width. Below 900px, desktop rail preference is preserved but navigation itself becomes an independent off-canvas drawer below the center topbar; the fixed topbar toggle, internal close target, and scrim all dismiss it without horizontal overflow. Opening a session also closes the drawer. Returning to desktop closes any transient drawer state without overwriting the user's desktop collapsed preference.
- Both side regions' widths are adjustable by dragging their boundary with the conversation (zero-width handles riding the shared edges), persist across reloads, and reset to the default on double-click; each boundary's scroll thumb keeps grab priority where the two overlap. A saved width is clamped live as the window narrows without overwriting the user's preference, then restored when space returns.
- The contextual region primarily hosts files and artifacts referenced by the conversation, while retaining the structure needed for later changes, session trees, subagents, and timelines. Files, Changes, and Branches use equal-width mode controls wide enough to preserve every label at the pane's minimum width. The region remains in the three-column layout while that layout can preserve a usable conversation; below that floor it becomes a drawer starting under the center topbar, so it never covers its own open/close control.
- Opening the product follows a remembered user choice: resume the previous session or show a welcome page. Bootstrap or socket loss keeps the last confirmed surface where one exists and retries automatically instead of presenting the interruption as a red operation error. Authentication failure means the host answered and opens the one-time browser-pairing surface; a network failure to the exact loopback origin means only that the host is not reachable (the browser cannot prove why), and names the address, `./inspire` recovery command, automatic retry, and manual retry without claiming that the service is certainly stopped. A later live-stream interruption preserves the last settled state and starts with the narrower reconnect explanation, then adopts the more specific bootstrap result. The production origin is installable as a standalone PWA: its service worker caches only the versioned application shell and same-origin static assets, never API, event, attachment, or resource responses. The cached shell can present those host-aware states, but cannot start a local process; Pi/session capability still requires the loopback host and its authenticated API.
- The welcome page host-deselects any visible session before presenting the first-message/project-directory composer, so the prior session no longer owns topbar status, resources, attention acknowledgement, Escape, or delete protection even if its idle worker remains warm. A collapsible recent-session list appears only when navigation is unavailable or collapsed; expanded desktop navigation already owns that route and is not duplicated. A missing project directory produces a non-blocking warning notice. Failed open/create operations remain in the navigation and start surfaces without replacing a transcript integrity error.
- The project directory can be typed or chosen through a host-side directory picker: the host process lists its own filesystem (`GET /api/host/dirs`, bearer-token guarded, session-independent), so over SSH forwards or remote deployments the browsed tree is always the machine sessions run on, and entry paths arrive joined with the host's own separators. Root discovery is host-owned too: POSIX exposes `/`, while Windows exposes every currently readable drive root so a user can cross from `C:\` to `D:\` without inventing a nonexistent common parent. A missing or relative starting point falls back to the host home.
- Persistent interface preferences live in a floating settings overlay opened from the topbar rather than consuming the session-navigation column. Settings fields remain inside their section at every supported width; explanatory copy yields space to its control and stacks above it on a narrow phone. Every modal overlay owns keyboard focus while open, cycles Tab within its surface, composes correctly when a newer modal appears above it, and restores the exact opener on close even when nested modals close out of order.
- Preference persistence is field-scoped and ordered: each change patches only its own fields through a serialized write path, so rapid or concurrent changes — including pin, folder-pin, and hide updates — can never overwrite one another with stale full snapshots. A refused write emits a warning notice and rolls its own fields back to the last value the host confirmed rather than to whatever was on screen when it started, so a run of refusals cannot leave a control showing a value nothing persisted; any field a newer local change has since claimed belongs to that change.
- Tool-card and thinking-card visibility preferences are independent and default to Dynamic. Their selectors put the recommended adaptive mode first, then fixed modes from most to least information: Thinking uses Dynamic, expanded, collapsed, hidden; Tools uses Dynamic, expanded, collapsed, Compact, hidden. Existing explicit preferences remain unchanged when the field is already stored.
- Completion attention is an explicit `off | title | desktop` preference, defaulting off. A title marker and desktop notification are derived only from a browser-observed live terminal transition: agent runs own their settle, nested compaction cannot consume that ownership, and a standalone manual compaction owns exactly its own end. Socket loss invalidates all observed ownership. Authoritative snapshots never create ownership; they retain an existing arm only while its session reports the matching operation still live, otherwise they retire it. Foreground selected work, historical/bootstrap status, and duplicate terminal events do not qualify. The marker composes with an extension-set title and clears when its owning session is viewed in a focused visible tab. Desktop permission is requested only by the Settings gesture, and denial or an unavailable API leaves saved intent unchanged while reporting the refusal through a warning notice. OS notification fields use fixed outcome copy, opaque session identity, and cwd-derived project metadata only; catalog title is forbidden because its unnamed fallback is conversation-derived first-message text. Clicking a notification focuses the window and selects the owning session.
- Users can change the shared card default and can override an individual card without changing that saved preference.
- The composer and host share one busy-state authority for `running`, `retrying`, `compacting`, and `queued`. Busy work presents steer, follow-up, and abort controls, including while input is queued; a prompt result may update only its sending session’s composer partition and may touch the visible global error only while that session remains visible.
- Visible controls make core operations discoverable while keyboard shortcuts and a command interface accelerate the same operations instead of replacing them.

## Non-goals

- The first release does not need to populate every future workbench surface.
- The interface does not reproduce a terminal layout or an existing reference application pixel for pixel.
