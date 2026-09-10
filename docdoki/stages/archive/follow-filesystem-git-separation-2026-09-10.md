---
scope:
  - server/project-files.ts
  - server/resources.ts
  - server/attachments.ts
  - server/runtime-composer-artifacts.ts
  - server/app.ts
  - src/api.ts
  - src/controllers/workspace-controller.ts
  - src/components/{WorkspaceBrowser,FilesPane,ProjectFiles,Composer,ComposerInput,Welcome,ChangesPane,HiddenFilesToggle}.tsx
  - src/store.ts
  - tests/server/**
  - tests/web/**
  - tests/browser/**
  - docdoki/specs/{resource-preview,composer}.md
---

# Filesystem and Git separation

## Objective

Follow the user's decision: Files represents the actual project filesystem, with visibility controlled only by filesystem hidden names/attributes. Changes owns Git state. Neither search membership nor Git ignore rules authorize file reads or prompt references.

## Decisions

- Files tree levels enumerate actual directories on demand, including empty directories and Git-ignored non-hidden entries. Bounded search and listing report incomplete results instead of silently declaring absence.
- A default-off Show hidden files control uses dot names and native hidden attributes consistently in Git and non-Git workspaces. Visibility is not permission; an explicit path remains independently usable.
- Workspace reads and prompt references require realpath containment and regular files independently of discovery. Preserve exact session/view ownership, pinned resource objects, symlink containment, citation authority outside the workspace, and all content/rendering limits.
- Document links/images and terminal links use that same independent resource boundary, not Git ignore rules. Remote images and sandbox policies do not change.
- A missing Git status entry does not establish a clean file: unavailable, truncated and non-repository observations remain unknown/not applicable rather than +0/-0.

## Current state

Completed. Filesystem discovery, hidden visibility and access authority are separated from Git across browsing, search, previews/downloads, document images/links, and composer references. Changes no longer infers zero counts from missing evidence. Contracts and prior evidence supersession are recorded in [[filesystem-git-separation]].

Verified on Linux with Node 22.19.0/npm 10.9.2: `npm run ci` passed (17 portable tests, 1,590 unit/launcher tests, 38 Chromium tests; 3 conditional skips). After final completion-heading cleanup, 32 composer tests and 5 affected browser tests, format/lint/typecheck/build passed again. Desktop and narrow screenshots were inspected. Native Windows/macOS behavior remains a stated verification limit; daily services and conversations were untouched.

## Next actions

None for this implementation. Commit/push handoff is authorized by the user. The separate holistic visual-design follow-up in [[follow-file-browsing-experience-2026-08-24]] remains open; this task does not reopen it or authorize service restarts.
