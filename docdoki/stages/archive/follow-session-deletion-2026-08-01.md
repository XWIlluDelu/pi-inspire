---
scope:
  - shared/contracts.ts
  - server/session-delete.ts
  - server/runtime.ts
  - server/app.ts
  - server/resources.ts
  - server/mock.ts
  - src/api.ts
  - src/store.ts
  - src/session-drafts.ts
  - src/components/Composer.tsx
  - src/components/Nav.tsx
  - src/components/SessionDeleteDialog.tsx
  - src/styles.css
  - tests/server/**
  - tests/web/**
  - docdoki/specs/session-continuity.md
  - docdoki/specs/workbench.md
---

# Session deletion

## Objective

Add a safe, host-owned way to delete an existing Pi session without crowding ordinary navigation or weakening Pi's one-writer boundary.

## Final state

- Ordinary session rows retain Pin and Hide. Hidden rows expose Restore and Delete, making hiding the reversible first stage before a destructive action.
- Deletion is addressed by catalog session ID, coordinated through the runtime lifecycle, and refuses selected, opening, active, conflicted, or otherwise unsafe sessions.
- The host validates the authoritative regular JSONL file and embedded session identity, attempts Trash first, then reports an explicit permanent-delete fallback.
- Successful deletion clears browser curation and per-session draft state, revokes resource handles, and coherently refetches the bounded session list.
- Focused server and web regressions, the full TypeScript/test/build checks, and desktop plus 390px browser flows passed.

## Decisions

- Ordinary session rows keep exactly two curation actions. Hidden rows replace Pin/Hide with Restore/Delete, preserving width and making deletion an explicit second stage after reversible hiding.
- The selected session and sessions with live work or unresolved interaction cannot be deleted. An idle unselected worker is stopped and detached before its JSONL is removed.
- Deletion addresses a catalog session identity, never a browser-provided path, and does not cascade to fork descendants or project files.
- The host mirrors Pi's trash-first behavior and reports whether the file was moved to Trash or permanently removed.
