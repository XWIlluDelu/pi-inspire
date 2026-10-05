---
scope:
  - src/components/**
  - src/styles/**
  - src/{terminal-*,highlight,pdf-renderer,resource-preview}.ts
  - src/controllers/{preference,resource}-controller.ts
  - shared/contracts.ts
  - server/{preferences,app}.ts
  - server/static-asset-cache.mjs
  - scripts/vite-pdf-assets.ts
  - tests/{web,browser}/**
---

# Interface, settings, and reader review

## Outcome

The existing palette, workbench structure, settings categories, and defaults remain. Repairs address
observed clipping, weak text contrast, lost interaction state, and broken previews.

| Area | Repairs |
| --- | --- |
| Workbench | Keep model controls and Git counts usable at 320px; use one History refresh; give nested menus first ownership of Escape; retain contextual readers/terminals across desktop/drawer transitions. |
| Settings | Unclip activity menus, respect reduced motion, distinguish disabled switches, and correct Restore defaults documentation. Field-owned persistence and default values remain unchanged. |
| Readers | Highlight Notebook cells and Makefiles, preserve traceback line breaks, open explicit line references in Source, and strengthen syntax/gutter contrast. Restore authorized audio/video playback. |
| PDF | Lazy static pages with text selection, paging, zoom/fit, preserved reading position, bounded canvases, and worker disposal. |
| Terminal | Keep settings above the pane and inside the viewport; restore modal focus; reveal selected tabs; preserve selection across reload; keep 320px controls reachable. |

Chromium 153 sandbox/CSP checks led to static PDF.js rendering; [[resource-preview]] retains the
reader boundary and rationale.

Contracts: [[design-system]], [[workspace-layout]], [[composer]], [[interface-preferences]],
[[rich-rendering]], [[resource-preview]], and [[terminal]].

## Verification

- Chromium on Linux: 320–1440px workbench and reader checks, Amber/Jade light/dark matrices, Settings
  persistence, nested Escape, document links/copy/line positioning, and real-PTY terminal interaction.
  All nine integrated browser flows passed.
- Syntax text measured at least 5.02:1 contrast across the inspected palettes/luminosities; Notebook
  prompts and diff gutters exceeded 5.4:1. PDF checks verified painted pixels, selectable text,
  page/zoom state through a layout change, inactive PDF actions, and worker disposal on replacement.
- The 1,119-test web suite passed for the UI changes. PDF integration then passed 57 focused
  reader/resource/modal/cache tests. Type checking, lint, formatting, unused-code analysis, and the
  production web build passed; PDF asset publication checks also passed.
- Committed regressions are in the affected web/server tests and `tests/browser/workbench.spec.ts`.
  Local captures are collected at `output/playwright/interface-review/gallery.png`, with originals
  in its `images/` directory.

Application work used isolated fixture Hosts. The daily Host and its sessions were not restarted.
