---
purpose: The product opens as a conversation-centered, collapsible workbench whose surrounding regions can grow without replacing the initial interface.
covers:
  - src/App.tsx
  - src/components/Nav.tsx
  - src/components/Welcome.tsx
  - src/components/DirectoryPicker.tsx
  - src/components/CommandPalette.tsx
  - src/components/Settings.tsx
  - src/components/ResourcesPane.tsx
  - src/use-modal-focus.ts
  - server/host-dirs.ts
  - src/styles.css
  - tests/web/app.test.tsx
  - tests/web/modal-focus.test.tsx
  - tests/web/nav.test.ts
---

# Workbench shell

## Goal

Give daily Pi work a coherent graphical home that starts focused and can expand toward a scientific workbench.

## Checks

- The primary desktop layout provides stable regions for project/session navigation, conversation, and contextual work.
- Project and session navigation remains visible at the left by default and files every session into exactly one section, in order: individually pinned sessions in one global top section, pinned project folders, the remaining folders grouped by working directory with newest activity first, and a Hidden group last. The conversation stays dominant in the center, and the right contextual region opens only when requested.
- Pinning and hiding are reversible navigation metadata that never touch Pi's session storage, and they are mutually exclusive: hiding a session drops its pin, pinning a hidden session takes it back out of Hidden, and each change travels as a single preference patch so the two identity lists cannot disagree. Folder pins use the exact cwd identity that already defines groups and their collapse state.
- An ordinary session row is one dense line carrying a single number: its title at the left, and at the right a compact activity age in a fixed column, preceded by the owning project only where a section crosses folders. Folder headers put their session count in that same column, so the panel reads down one right-hand rule. The exact timestamp and the message count stay in tooltips rather than becoming a second number. The pin and hide actions take over that column on hover or focus without moving anything, and where there is no hover to reveal them they take their own space beside the age.
- Project groups expose native expand/collapse controls; a collapsed group containing the visible session carries the active highlight on its header, and active search results remain visible regardless of saved collapse state. Hidden is a curation drawer rather than a browsing group: it opens on demand, starts closed again, and search reveals matching hidden sessions inside it instead of returning them to their folders.
- The navigation column’s lower half offers a collapsible workspace explorer over the visible session’s project index; its rows open the same session-bound preview surface as conversation references.
- The topbar owns session identity — rename in place, plus the project location shown as folder name or full path per a global preference, where clicking copies the absolute path without shifting layout.
- The navigation and contextual regions can collapse so the conversation can use the available width.
- Both side regions' widths are adjustable by dragging their boundary with the conversation (zero-width handles riding the shared edges), persist across reloads, and reset to the default on double-click; each boundary's scroll thumb keeps grab priority where the two overlap.
- The contextual region primarily hosts files and artifacts referenced by the conversation, while retaining the structure needed for later changes, session trees, subagents, and timelines.
- Opening the product follows a remembered user choice: resume the previous session or show a welcome page.
- The welcome page starts a session from a first message with an optional project directory and offers a collapsible recent-sessions list as the route back to previous work.
- The project directory can be typed or chosen through a host-side directory picker: the host process lists its own filesystem (`GET /api/host/dirs`, bearer-token guarded, session-independent), so over SSH forwards or remote deployments the browsed tree is always the machine sessions run on, and entry paths arrive joined with the host's own separators. A missing or relative starting point falls back to the host home.
- Persistent interface preferences live in a floating settings overlay opened from the topbar rather than consuming the session-navigation column. Every modal overlay owns keyboard focus while open, cycles Tab within its surface, composes correctly when a newer modal appears above it, and restores the exact opener on close even when nested modals close out of order.
- Preference persistence is field-scoped and ordered: each change patches only its own fields through a serialized write path, so rapid or concurrent changes — including pin, folder-pin, and hide updates — can never overwrite one another with stale full snapshots. A refused write reports the failure and rolls its own fields back to the last value the host confirmed rather than to whatever was on screen when it started, so a run of refusals cannot leave a control showing a value nothing persisted; any field a newer local change has since claimed belongs to that change.
- Tool-card and thinking-card visibility preferences are independent and each supports hidden, collapsed, and expanded defaults.
- Users can change the shared card default and can override an individual card without changing that saved preference.
- Visible controls make core operations discoverable while keyboard shortcuts and a command interface accelerate the same operations instead of replacing them.

## Non-goals

- The first release does not need to populate every future workbench surface.
- The interface does not reproduce a terminal layout or an existing reference application pixel for pixel.
