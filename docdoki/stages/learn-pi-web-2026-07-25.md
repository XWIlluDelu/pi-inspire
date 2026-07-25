---
scope:
  - src/**
  - server/mock.ts
  - tests/web/**
  - docdoki/specs/workbench.md
  - docdoki/specs/conversation.md
  - docdoki/specs/composer.md
---

# Learning from pi-web

## Objective

Fold the worthwhile ideas from [pi-web](https://github.com/ct-jyjntc/pi-web)
(a Next.js/Electron GUI for the same Pi agent) into insπre's own design
language: adopt the simple wins directly, and stage the larger feature
increments as a recorded backlog instead of copying its architecture
(monolithic components, inline styles, Next/Electron shell — all rejected).

## Current state

Round 1 landed 2026-07-25; `npm run check` green (typecheck + 148 tests),
all three changes verified live against the mock host:

- Tool results recognized as unified diffs render as typed, tinted lines
  (`src/diff.ts` parser + `DiffView` in the transcript; strict recognition —
  hunk header plus both file markers required — so Markdown bullets are never
  recolored). The mock session now carries an `edit` tool result to keep this
  visually checkable.
- Both side panes are width-resizable via zero-layout-width handles
  straddling their conversation-facing boundary (shared `PaneResizeHandle`:
  ±4px hit band, thumb-priority under the scroll rail, double-click reset,
  arrow-key support, localStorage persistence, disabled in overlay
  breakpoints; the nav's collapse transition is suppressed during a drag so
  resizing tracks the pointer).
- The composer keeps one unsent draft per session (in-memory map, restored
  on switch; extension `set_editor_text` and successful sends write through).

## Next actions

Deferred feature increments, roughly in value order:

1. **Minimap × fork fusion.** Evolve the reading scroll rail so hover
   reveals message-position ticks with jump-on-click, then extend the same
   track to branch points and bookmarks. Data layer is already native to the
   Pi SDK: session entries form an id/parentId tree (`getTree()`; in-session
   fork points are nodes with >1 children), the session header's
   `parentSession` names the source of a cross-session fork (fork *entry*
   should be recorded at creation via `appendCustomEntry`), and `LabelEntry`
   provides user bookmarks. Keep the rail's quiet resting identity — ticks
   appear on hover, no permanent minimap column.
2. **`@` file completion in the composer**, reusing the project index and
   pi-web's pure scoring ladder (exact/prefix/substring/path/subsequence,
   directory drill-down with quoted paths — see `lib/file-fuzzy.ts` there).
3. **`/` command palette in the composer**: surface Pi's extension commands
   and our built-ins, grouped by source, once the runtime exposes the list.
4. **Session fork / edit-from-here** (user-message hover action creating a
   branched session) and an in-session branch switcher; pairs with item 1.
5. **Streaming robustness** in the runtime client: periodic state reconcile
   so a lost end event cannot strand the UI in "running", drop late
   streaming events from finished runs, coalesce high-frequency deltas per
   frame.
6. **Tabbed right workspace** (files / git / terminals sharing one
   container) — only when git or terminal panels become real requirements.

Checked and closed: the highlight.js bundle already imports `lib/common`
with a `getLanguage` fallback, so pi-web's PrismLight lesson (explicit
language registration) was already satisfied here.

## Decisions

- Adopt techniques and features, not architecture: pi-web's per-component
  inline styling, 2000-line components, and Next/Electron packaging are
  explicitly not models for insπre.
- Diffs render unified (single column) rather than pi-web's split view: the
  reading column is 760px and card bodies are narrower still; two 350px
  code columns would wrap constantly.
- The resize handle and the boundary scroll rail coexist on one edge by
  z-order: the rail thumb (its only interactive part) sits above the ±4px
  resize band, so scrolling wins inside the thumb and resizing everywhere
  else; cursors (grab vs col-resize) disambiguate.
