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

Keep reading, composing, and inspection consistent across desktop and narrow layouts. The
following contracts own the implemented behavior.

| Area | Contract |
| --- | --- |
| Navigation, startup and disclosure | [[workbench]] and [[workspace-layout]] |
| Transcript search, Prompt Map, Activity and Copy | [[conversation]], [[activity-presentation]] and [[rich-rendering]] |
| Composer sizing, input and model controls | [[composer]] and [[design-system]] |
| Shared tabs, Git inspection, file offsets and PDF | [[workspace-layout]] and [[resource-preview]] |
| Terminal tools and reconnect | [[terminal]] |
| Settings, themes and local restart recovery | [[interface-preferences]] and [[host-lifecycle]] |

## Evidence and open acceptance

- Browser checks cover contextual search and focus return, resize with both side panes, drawer
  dismissal, short-window reachability, independent file offsets, and refresh without lost content.
  Restoring a selected session during bootstrap keeps the Welcome composer from flashing. Files
  fixtures exercise authored links, long paths, PDF, and Source/rendered position retention.
- Prior matched Chromium views covered desktop, 320–390px phone widths and landscape in light and
  Mono dark. Narrow-input checks also ran in Firefox. Physical-device font and installed-window
  appearance remain open under [[follow-runtime-quality-2026-10-25]].
- Linux file-manager acceptance used the authenticated endpoint and acknowledged FileManager1
  calls. Native Finder and Windows invocation still need acceptance.

## Undecided interaction proposals

These remain proposals, not implemented requirements:

- A command-palette entry that discovers existing actions without duplicating their policy.
- Discoverable keyboard access to thinking and slash-command choices, with IME-safe handling.
- Clearer attachment-upload progress that preserves durable retry and draft ownership.
- Visual differentiation of project groups.
- A quieter idle composer and less decorative chrome around short messages or reasoning blocks.

Assess each against its workflow before implementation. Preserve action availability, reading
behavior and the accepted layout. The separate holistic Files layout remains in [[file-browsing]];
it does not authorize a new left tree or split reader.
