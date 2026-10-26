---
scope:
  - src/**
  - tests/browser/**
  - docdoki/specs/design-system.md
  - docdoki/specs/interface-preferences.md
  - docdoki/specs/resource-preview.md
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
