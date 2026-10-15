---
scope:
  - docdoki/specs/{resource-preview,workspace-layout,workbench}.md
  - src/components/{ContextPane,FilesPane,ChangesPane,WorkspaceBrowser,FilePreview}.tsx
  - src/controllers/{workspace,resource,git}-controller.ts
  - src/styles/*.css
  - tests/web/resources-pane.test.tsx
  - tests/browser/filesystem-files.spec.ts
---

# File browsing experience

## State

Functional browsing and readers are implemented. The broader visual redesign is **deferred**.
[[resource-preview]] owns discovery, authorization and preview behavior; [[workspace-layout]] owns
the current pane geometry.

## Deferred design questions

Treat Files as one responsive design task:

- Could a sufficiently wide pane place search in the mode bar to recover vertical space?
  Narrow panes and phones need the full-width search row. The current row stays until a complete
  responsive treatment is selected.
- How should the lower-left project-file header separate from Sessions without arbitrary tint?
  The context-surface tint was rejected.
- Keep that header limited to the project basename and collapse control. A separate “open right
  pane” icon duplicates file selection and the workbench's pane control.

Evaluate the complete flow in wide, resized, dark-theme and phone views rather than reopening
isolated color or placement experiments.

## Requirements for that work

- Preserve session-bound realpath authorization, bounded filesystem reads, hidden visibility,
  and resource-preview limits. Filesystem membership and Git observations remain separate.
- Keep browsing read-only, without another eager index or an unbounded browser tree.
- Let users locate a known path without expanding every ancestor, and retain one visible path
  identity from discovery through preview.
- Distinguish workspace files, conversation references and Changes while keeping their navigation
  coherent. Narrow navigation-to-preview opens only the intended drawer and provides an obvious return.
- Check disclosure, selection, keyboard navigation, resizing and responsive transitions in a browser.
