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
- Project and session navigation remains visible at the left by default, places persistent pinned sessions in one global top section, groups every unpinned session by working directory with newest activity first, keeps the conversation dominant in the center, and opens the right contextual region only when requested.
- Project groups expose native expand/collapse controls; a collapsed group containing the visible session carries the active highlight on its header, and active search results remain visible regardless of saved collapse state.
- The navigation column’s lower half offers a collapsible workspace explorer over the visible session’s project index; its rows open the same session-bound preview surface as conversation references.
- The topbar owns session identity — rename in place, plus the project location shown as folder name or full path per a global preference, where clicking copies the absolute path without shifting layout.
- The navigation and contextual regions can collapse so the conversation can use the available width.
- Both side regions' widths are adjustable by dragging their boundary with the conversation (zero-width handles riding the shared edges), persist across reloads, and reset to the default on double-click; each boundary's scroll thumb keeps grab priority where the two overlap.
- The contextual region primarily hosts files and artifacts referenced by the conversation, while retaining the structure needed for later changes, session trees, subagents, and timelines.
- Opening the product follows a remembered user choice: resume the previous session or show a welcome page.
- The welcome page starts a session from a first message with an optional project directory and offers a collapsible recent-sessions list as the route back to previous work.
- The project directory can be typed or chosen through a host-side directory picker: the host process lists its own filesystem (`GET /api/host/dirs`, bearer-token guarded, session-independent), so over SSH forwards or remote deployments the browsed tree is always the machine sessions run on, and entry paths arrive joined with the host's own separators. A missing or relative starting point falls back to the host home.
- Persistent interface preferences live in a floating settings overlay opened from the topbar rather than consuming the session-navigation column. Every modal overlay owns keyboard focus while open, cycles Tab within its surface, composes correctly when a newer modal appears above it, and restores the exact opener on close even when nested modals close out of order.
- Preference persistence is field-scoped and ordered: each change patches only its own fields through a serialized write path, so rapid or concurrent changes — including pin updates — can never overwrite one another with stale full snapshots.
- Tool-card and thinking-card visibility preferences are independent and each supports hidden, collapsed, and expanded defaults.
- Users can change the shared card default and can override an individual card without changing that saved preference.
- Visible controls make core operations discoverable while keyboard shortcuts and a command interface accelerate the same operations instead of replacing them.

## Non-goals

- The first release does not need to populate every future workbench surface.
- The interface does not reproduce a terminal layout or an existing reference application pixel for pixel.
