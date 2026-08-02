---
scope:
  - server/**
  - src/store.ts
  - src/api.ts
  - tests/server/**
  - tests/web/preferences.test.ts
  - docdoki/**
---

# External review reconciliation

Closed 2026-07-25 in one round: an external code review's findings were
verified against the code and repaired where real. Its four priority items
matched the then-recorded correctness backlog plus one new finding.

## Outcome

- Preferences lost update — fixed. `PATCH /api/preferences` accepts
  field-scoped patches merged under the store's serialized write queue; the
  client applies patches in order through its own queue, each carrying only
  its changed fields, and takes only `pinnedSessionIds` from pin responses.
- Stale resource handles — fixed. Content requests compare the handle's
  session against the runtime's visible session (409 otherwise), and
  `resourceContext` re-checks the selection after its awaited message fetch.
- Provisional extension dialogs — fixed. Slot events stay host-local until
  the slot is registered under Pi's final session id, and a dialog captured
  under a `pending-*` id is rebound to the final id, so it stays answerable.
- Attachment accumulation — bounded. Withdrawing a staged attachment (or
  removing one whose upload was still in flight) deletes the host cache copy
  via `DELETE /api/attachments/:id`; image uploads are reclaimed once a
  delivered prompt has inlined their bytes.
- Correction to the review: deleting every attachment after prompt delivery
  would be wrong — ordinary files are referenced by host path inside the
  conversation text and Pi may read them for the rest of the session, so only
  images are reclaimed on consumption and files persist until host exit.
- Deferred with the review's agreement: selector-based store subscriptions
  and the other efficiency items require measurement and now live in
  [[groom-evidence-gated-maintenance-2026-08-01]].
- Docs reconciled: preference, resource-handle, dialog-rebinding, and
  attachment-lifetime contracts added to the workbench, resource-preview,
  session-continuity, and composer specs; the navigation stage archived; the
  deferred remainder later consolidated into the product roadmap.

Verified by `npm run check` (152 tests green) with new regressions for each
fix: racing field patches, old-handle 409 after a switch, a dialog raised
before `get_state` answers, and image-consumed vs file-kept reclamation.
