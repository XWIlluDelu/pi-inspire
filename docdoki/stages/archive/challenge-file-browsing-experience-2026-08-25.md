---
scope:
  - src/components/Nav.tsx
  - src/components/ResourcesPane.tsx
  - src/components/WorkspaceBrowser.tsx
  - src/components/RichText.tsx
  - src/controllers/resource-controller.ts
  - src/controllers/workspace-controller.ts
  - src/file-registry.ts
  - src/store.ts
  - src/styles.css
  - src/api.ts
  - server/app.ts
  - server/resources.ts
  - shared/contracts.ts
  - tests/browser/workbench.spec.ts
  - tests/server/resources.test.ts
  - tests/web/nav-render.test.tsx
  - tests/web/resources-pane.test.tsx
  - tests/web/file-registry.test.ts
  - tests/web/workspace-controller.test.ts
---

# File browsing experience

## Objective

Turn the left-side project tree and right-side Files region into two coherent projections of one session-bound file workbench, while preserving the established Trace2 visual language and the conversation-first three-region layout.

## Current state

- Working: one workspace controller owns lazy directory levels, path search, expansion, refresh, retry, canonical selection, transport invalidation, and stale-request rejection for both surfaces.
- Working: the left `Files` navigator provides quick project access and a full-browser launcher without becoming a second file-state authority.
- Working: the right Files workbench combines All, Workspace, Referenced, and Recent views; joins indexed and cited spellings by canonical workspace path; and provides Preview, numbered Source, and Info views with Git and reference decoration.
- Working: resource authorization remains session and branch-view bound, while a lightweight workspace-relative selection survives pane close and responsive remount without retaining preview bytes or filesystem authority.
- Working: narrow screens use one modal owner and explicit list → detail → Back navigation; wide screens retain the shared persisted outer and internal resize mechanisms with a useful default tree allocation.
- Modified files: workspace/resource contracts and Host endpoints; shared controller, registry, store, navigation, file workbench, rich-text references, styling; focused Web, Server, and browser coverage; [[resource-preview]], [[workbench]], and the spec abstract.

## Decisions

- Keep the three-region workbench. The left surface is the fast navigator; the right surface is the complete read-only browser and preview owner.
- Reuse the project index and authenticated resource resolver rather than introduce cwd-containment browsing, a second filesystem API, or arbitrary client path access.
- Preserve conversation-only citations as authorized references while using Host-resolved workspace-relative paths as the unifying identity whenever an indexed file exists.
- Retain the existing History search, global fold/refresh controls, and established styling; the review claims that those were missing were stale and did not justify parallel implementations.

## Handoff

The file-browsing challenge is complete and its standing contracts are in [[resource-preview]] and [[workbench]]. Future file actions should extend the shared workspace controller and canonical registry rather than add local tree state to either pane.
