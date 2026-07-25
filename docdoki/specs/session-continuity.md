---
purpose: Existing Pi JSONL session trees remain the single conversation authority while inspire adds fast discovery, switching, continuation, and safe handoff.
covers:
  - shared/contracts.ts
  - server/session-catalog.ts
  - server/session-preview.ts
  - server/runtime.ts
  - server/app.ts
  - src/store.ts
  - src/components/Nav.tsx
  - src/components/Welcome.tsx
  - src/components/Transcript.tsx
  - tests/server/app.test.ts
  - tests/server/mock.test.ts
  - tests/server/runtime.test.ts
  - tests/web/app.test.tsx
  - tests/web/store.test.ts
---

# Session continuity

## Goal

Let the user move between existing terminal Pi and inspire without losing history or learning a second session system.

## Checks

- inspire discovers sessions from the same Pi session storage selected by the user’s Pi configuration.
- A session can be listed, searched, opened, continued, named, and switched using Pi’s identity and tree rather than copied into another conversation store.
- Session listing reads bounded metadata and remains responsive without loading every full JSONL file into the browser.
- Opening an unopened session first projects its active branch through Pi’s read-only parser and context builder, without waiting for extensions or writing the JSONL; transcript virtualization avoids mounting every entry in a large history at once.
- The independent Pi worker warms outside the selection critical path, and its `runtime_ready` event replaces the temporary preview with authoritative RPC state only if that session is still selected.
- Refreshing or reconnecting reconciles live events against an authoritative Pi snapshot without duplicating settled messages or letting a delayed snapshot replace a newer selection.
- New sessions, naming, switching, and compaction use Pi’s supported runtime operations; branch-tree navigation can join the contextual workbench in a later release.
- Each session activated in inspire owns an independent Pi runtime, and selecting another conversation changes only the browser projection; background runs continue without interruption.
- Navigation exposes current work and unseen completion per session: running, successful completion awaiting review, and error completion awaiting review remain distinct until the user opens that session.
- Persistent pin and folder-collapse metadata belongs to inspire preferences, not Pi JSONL; pinned sessions remain discoverable even when they fall outside the first chronological catalog page.
- A dialog request raised by a background extension remains attached to its owning worker and is restored when that session is viewed; responses carry both session and request identity so concurrent navigation cannot misroute or orphan required input. A dialog raised while a new session still carries its provisional identity is rebound to Pi’s final session id — provisional ids never leave the host — so early extension questions stay answerable.
- inspire never starts a second worker for a session it already owns and does not modify session JSONL directly while a Pi runtime owns it.

## Non-goals

- The product does not synchronize the same writable session across independent Pi processes.
- A derived search index, when introduced, is rebuildable and never becomes conversation authority.
