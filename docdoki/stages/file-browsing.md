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

Evaluate the complete flow in wide, resized, dark-theme and phone views rather than reopening
isolated color or placement experiments.

Keep one visible path identity from discovery through preview, and preserve direct access to known
paths. Use the existing bounded reads. Check disclosure, selection, keyboard navigation, resizing and
drawer return as part of the same browser flow.
