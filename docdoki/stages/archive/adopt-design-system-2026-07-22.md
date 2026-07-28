---
scope:
  - docdoki/specs/design-system.md
  - docdoki/specs/visual-language.md
  - index.html
  - src/**
  - shared/contracts.ts
  - server/preferences.ts
  - tests/web/**
---

# Design system adoption

## Objective

Install the design-token and component contract, then replace the draft chrome
with the restrained scientific-workbench interface defined by
[[design-system]] and [[visual-language]].

## Current state

- Completed: `src/styles.css` is the token authority for both themes; vendored
  Noto Sans SC, IBM Plex Serif, and IBM Plex Mono own their specified roles.
- The workbench, transcript, composer, navigation, resource pane, overlays,
  dropdowns, focus grammar, scroll rails, pane resizing, and responsive states
  implement the standing component contracts.
- Follow-on interaction rounds adopted session drafts, project-index Explorer,
  session-bound previews, typed compact behavior, semantic activity annotation,
  and accessible modal focus without introducing a second design authority.

## Decisions

- One teal accent family is tuned per theme; thinking, tool, success, warning,
  and failure colors are semantic annotations rather than decoration.
- Noto Sans SC owns interface and reading text, IBM Plex Serif is limited to the
  wordmark, and IBM Plex Mono owns code and machine data. Reading-mode font
  switching was removed.
- The workspace Explorer and resource preview share the project index as their
  bounded workspace authority; transcript citations remain the other explicit
  resource authority.
- `/compact` remains a typed command routed by the host because Pi RPC prompt
  handling does not interpret Pi's built-in command itself.
- Structural separation comes from surface steps; hairlines stay with
  in-content instruments rather than becoming pane dividers.
