---
scope:
  - src/components/TerminalPane.tsx
  - src/components/TerminalView.tsx
  - src/components/ContextPane.tsx
  - src/terminal-command-output.ts
  - src/terminal-menus.ts
  - src/styles/terminal.css
  - tests/web/terminal-*.test.*
  - tests/browser/workbench.spec.ts
  - docdoki/specs/terminal.md
---

# Compact terminal controls

## Objective

Follow the user's delegated terminal redesign: retain essential interactive-shell
and conversation workflows, remove low-value features, and give output more room.
The updated contract is [[terminal]].

## Decisions

- Keep the existing IBM Plex Sans SC / Flux Mono SC type roles and light/dark
  terminal tokens; this is a quiet workbench instrument, not a separate visual
  identity. Use one aligned header: tabs, new/profile, status/search, focus, more.
- Search and selection actions appear only when relevant. Copy and Add to chat
  are contextual, and quoting still only fills the composer.
- One more menu owns clipboard/output actions, terminal management, the
  all-project navigator, and settings. Inline disclosure groups keep less-used
  actions available without a permanently expanded list or extra toolbar icons.
- Remove Duplicate, browser command-history navigation, copying the last command,
  and directly rerunning a command. Retain copying the last completed output;
  only that output's marker range needs to be retained in the view.
- Keep explicit control takeover, disconnect/exited state, paste protection,
  search, tab order, rename, restart/close confirmation, recent-close recreation,
  focused window, settings, and touch modifiers. Do not alter PTY/daemon authority.

## Current state

Completed. The compact header, contextual controls, grouped menus, and feature
removals are implemented without remounting xterm or changing PTY authority.
Browser checks also drove output-boundary, overlay-stacking, clipboard-ownership,
and focus repairs.

[[terminal-controls-redesign]] retains the implementation boundaries and evidence:
130 terminal-focused tests, three Chromium terminal scenarios, desktop/narrow
light/dark screenshots and axe checks, typecheck/build, format/lint, and unused-code
checks passed. The running Host was not restarted. Existing unrelated lockfile
changes remain outside this work. There are no outstanding implementation tasks
for this redesign.
