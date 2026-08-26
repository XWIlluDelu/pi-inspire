---
scope:
  - docdoki/specs/resource-preview.md
  - docdoki/specs/workbench.md
  - server/resources.ts
  - shared/resource-references.ts
  - src/App.tsx
  - src/components/ContextPane.tsx
  - src/components/ContextPaneState.tsx
  - src/components/ContextSplitBody.tsx
  - src/components/FilesPane.tsx
  - src/components/FilePreview.tsx
  - src/components/ChangesPane.tsx
  - src/components/WorkspaceBrowser.tsx
  - src/components/PaneResizeHandle.tsx
  - src/components/ResourcePathLabel.tsx
  - src/controllers/workspace-controller.ts
  - src/controllers/resource-controller.ts
  - src/controllers/git-controller.ts
  - src/store.ts
  - src/styles.css
  - tests/web/resources-pane.test.tsx
  - tests/web/workspace-controller.test.ts
  - tests/browser/workbench.spec.ts
---

# File browsing experience

## Objective

Make workspace discovery and contextual file inspection feel like one coherent flow without turning INSΠRE into a file editor or a second IDE.

## Status

The selected functional scope is implemented, stabilized, documented, and release-validated. Its broader visual redesign remains explicitly deferred.

## Selected functional scope

- One cwd-scoped `WorkspaceController` owns lazy levels, expansion, search, refresh, one-shot selection reveal, request cancellation, and transport/session acceptance. The compact navigation tree and right Files browser consume that same projection.
- The compact lower-left surface keeps only the project basename, disclosure, and tree. Workspace search belongs to Files Browse, which also presents at most five deduplicated recent conversation files.
- Selecting a workspace, search, recent, transcript, or Git file replaces Browse with a fixed index/detail stack: the shared workspace tree stays above the preview, while a compact project-folder row returns to Browse without losing tree, query, or Browse scroll state.
- Files and Changes share fixed upper-region, divider, detail-header, source-canvas, and narrow-drawer geometry without an internal splitter. Files owns preview/source reading; Changes owns grouped Git facets and source diffs.
- Recent refreshes run only while Browse is visible and retain the previous page and standing until current results arrive. Preview stays mounted through compatible transcript appends, preserving its reader scroll. Git polling likewise retains the selected diff and scroll while that exact facet remains present.
- Resource probe and resolve generations prevent stale standing from overwriting a successful preview. Downloads stream through the authenticated resource route, text detection covers common source/configuration names, truncated rendered previews are explicit, and every iframe uses the same empty sandbox capability set.
- On narrow layouts, opening a resource from navigation closes that drawer before the contextual drawer appears. Directory, search, probe, preview, Git, session, view, and transport transitions reject stale asynchronous results.

## Next actions

Treat the Files surfaces as one later, holistic visual-design task rather than continuing local color and placement experiments:

- Reconsider whether a sufficiently wide desktop Files pane should place workspace search in the top mode bar to recover vertical space. Keep the full-width search row on narrow panes and phones; the current full-width row remains authoritative until a complete responsive treatment is accepted.
- Find a quiet way to distinguish the lower-left project-file header from the Sessions region without relying on an arbitrary tinted background. The attempted context-surface color was rejected and removed.
- Keep the lower-left header limited to the project basename and collapse control. Do not restore a dedicated “open right pane” icon: selecting a file already opens its preview, and the workbench has its own global pane control.
- Evaluate these choices together against real-browser wide, resized, dark-theme, and phone states before changing the current design.

## Constraints

- Preserve session-bound realpath/index authorization, bounded directory reads, ignored-path handling, and the existing resource-preview safety limits.
- Preserve the distinct semantics of conversation references and Git Changes; visual unification must not merge their data authorities.
- Keep the surface read-only. Editing, file mutation, terminal emulation, and a complete IDE project manager remain out of scope.
- Do not add a second eager repository index or materialize an unbounded tree in the browser.

## Acceptance direction

- The compact entry point identifies the current project without duplicating search or full-workbench controls.
- A user can locate a known path in a large workspace without manually expanding and traversing every ancestor.
- Selection has one visible path identity and coherent active state from discovery through preview.
- Switching between workspace files, referenced files, and Changes is understandable without conflating their meanings.
- Narrow navigation-to-preview flow leaves only the intended top drawer active and has an obvious return path.
- Disclosure, selection, keyboard navigation, resize behavior, and responsive transitions are covered in a real browser.
