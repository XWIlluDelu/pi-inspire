---
scope:
  - src/**
  - tests/browser/**
  - docdoki/specs/design-system.md
  - docdoki/specs/interface-preferences.md
  - docdoki/specs/resource-preview.md
  - docdoki/specs/workspace-layout.md
  - docdoki/specs/composer.md
---

# Workbench interactions

## Objective

Keep conversation reading, resource inspection and settings controls consistent across desktop
and narrow layouts. [[design-system]], [[interface-preferences]], [[session-persistence]] and
[[resource-preview]] own the implemented contracts.

## Implemented decisions

- Desktop conversation search stays visible at the upper right. Ctrl/Cmd+F focuses it;
  Escape blurs without clearing the query. Narrow layouts retain the mobile search launcher.
- Changes uses an inline diff on narrow screens. Its filename filters and session search share
  compact search controls with a named clear action that restores input focus.
- Refreshing Files or Changes preserves the current rows and reader. Success, validation and
  loading feedback stay with the initiating control; retained warnings remain in the notice stack.
- Rounded containers, buttons and fields use the selected smaller radii. Files/Changes use
  understated underlined labels without changing selection or pane height.
- Existing structural type sizes remain unchanged. Additional pane borders were declined.
  Keep the previous uncluttered layout rather than reopening those alternatives.
- Shared error text uses semantic, palette-specific ink with readable dark-mode contrast.
  Installed titlebar dimming follows application overlays, without forcing Android system-bar
  colors or changing scrim scope.

## Verification boundary

Automated checks cover shared search controls, narrow inline diffs, transient feedback, titlebar
blending, palette contrast and desktop/touch search. Device-owned Android window chrome still
requires physical-device acceptance; [[follow-runtime-quality-2026-10-25]] tracks it.

## Right-pane tabs

The right pane gives opened files filename tabs and keeps Files/Changes/History/Terminal
as fixed trailing icon tabs sharing one content area. The file browser remains on the right; there
is no extra left tree, Files split or nested Files history level. Composer attachments share the
existing text/model-label inset. Following the user's correction, navigation retains its previous
460px manual maximum. The right pane may use the remaining shared width budget rather than a
fixed 920px ceiling; default widths and the conversation reserve remain unchanged.

Browser interaction checks confirm independent scroll positions for two files, retained Files query,
terminal output and unfinished input across tab switches and the shared width budget at 1280px.
A separate rendered-message check covers long URLs, tables, code, images and
formulas at 1920, 1280, 980, 390 and 320px, with local scrolling for wide blocks and no document
overflow. These reading checks
do not claim retained iframe-internal or video playback state; leaving interactive HTML still
retires its capability and requires explicit re-enabling. Focused checks passed: 127 resource/app
tests, 74 terminal tests, three pane-resize tests and 58 Chromium browser cases, plus the content
geometry scenario. Web typechecking, changed TypeScript formatting/lint and import boundaries pass.
Browser checks exposed and corrected clipped file-tab focus/close controls at 320px; refresh tests
now establish actual scroll range and fresh fixture discovery, and header measurements wait for
Git content before reading parent/child geometry together. The active filename tab remains visible
when the strip narrows. No assertion was relaxed for a failure.

The corrected right-pane width passes the three existing Chromium resize cases and the rendered-content
scenario: at 1920px the context pane reaches 1236px while navigation remains 272px and the conversation
retains 400px; at 1280/980px it yields to 648/348px. The 390/320px drawers and conversation remain
contained. Full project typechecking and import boundaries also pass. The user approved auto-dev
publication and deployment after these checks; main and the existing release tag are outside scope.

## Undecided interaction proposals

The following remain proposals, not implemented requirements:

- A command-palette entry that discovers existing actions without duplicating their policy.
- Discoverable keyboard access to thinking and slash-command choices, with IME-safe handling.
- Clearer attachment-upload progress that preserves durable retry and draft ownership.
- An accessible grip for pane resizing and visual differentiation of project groups.
- A quieter idle composer and less decorative chrome around short messages or reasoning blocks.

Review each against its actual workflow before implementation. Preserve action availability,
reading behavior and the user's accepted layout; wider terminal, MCP and settings work has no
additional acceptance requirement from these proposals.
