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
matched the recorded correctness backlog in
`notes/follow-up-code-review-2026-07-22.md` plus one new finding.

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
  and the other efficiency items stay in the follow-up note until measured.
- Docs reconciled: preference, resource-handle, dialog-rebinding, and
  attachment-lifetime contracts added to the workbench, resource-preview,
  session-continuity, and composer specs; the navigation stage archived; the
  follow-up note rewritten to its open remainder.

Verified by `npm run check` (152 tests green) with new regressions for each
fix: racing field patches, old-handle 409 after a switch, a dialog raised
before `get_state` answers, and image-consumed vs file-kept reclamation.
