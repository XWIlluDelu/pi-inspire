---
purpose: The product opens as a conversation-centered, collapsible workbench whose surrounding regions can grow without replacing the initial interface.
covers:
  - src/App.tsx
  - src/components/Nav.tsx
  - src/components/Welcome.tsx
  - src/components/CommandPalette.tsx
  - src/styles.css
  - tests/web/app.test.tsx
---

# Workbench shell

## Goal

Give daily Pi work a coherent graphical home that starts focused and can expand toward a scientific workbench.

## Checks

- The primary desktop layout provides stable regions for project/session navigation, conversation, and contextual work.
- Project and session navigation remains visible at the left by default, the conversation remains the dominant center surface, and the right contextual region opens only when requested.
- The navigation and contextual regions can collapse so the conversation can use the available width.
- The contextual region can later host files, changes, session trees, subagents, timelines, and artifacts without restructuring the conversation model.
- Opening the product follows a remembered user choice: resume the previous session or show a welcome page.
- The welcome page offers a clear route to the previous session, recent sessions, a new session, and another project.
- Tool-card and thinking-card visibility preferences are independent and each supports hidden, collapsed, and expanded defaults.
- Users can change the shared card default and can override an individual card without changing that saved preference.
- Visible controls make core operations discoverable while keyboard shortcuts and a command interface accelerate the same operations instead of replacing them.

## Non-goals

- The first release does not need to populate every future workbench surface.
- The interface does not reproduce a terminal layout or an existing reference application pixel for pixel.
