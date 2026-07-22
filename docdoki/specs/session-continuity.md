---
purpose: Existing Pi JSONL session trees remain the single conversation authority while inspire adds fast discovery, switching, continuation, and safe handoff.
covers:
  - server/session-catalog.ts
  - server/runtime.ts
  - server/app.ts
  - src/store.ts
  - src/components/Nav.tsx
  - src/components/Welcome.tsx
  - src/components/Transcript.tsx
  - tests/server/app.test.ts
  - tests/web/app.test.tsx
---

# Session continuity

## Goal

Let the user move between existing terminal Pi and inspire without losing history or learning a second session system.

## Checks

- inspire discovers sessions from the same Pi session storage selected by the user’s Pi configuration.
- A session can be listed, searched, opened, continued, named, and switched using Pi’s identity and tree rather than copied into another conversation store.
- Session listing reads bounded metadata and remains responsive without loading every full JSONL file into the browser.
- Opening a session reconstructs its active Pi branch, while transcript virtualization avoids mounting every entry in a large history at once.
- Refreshing or reconnecting reconciles live events against an authoritative Pi snapshot without duplicating settled messages.
- New sessions, naming, switching, and compaction use Pi’s supported runtime operations; branch-tree navigation can join the contextual workbench in a later release.
- inspire serializes session replacement through one owned Pi process and returns an ordinary conflict state instead of silently switching during active work.
- inspire does not modify session JSONL directly while a Pi runtime owns it.

## Non-goals

- The product does not synchronize the same writable session across independent Pi processes.
- A derived search index, when introduced, is rebuildable and never becomes conversation authority.
