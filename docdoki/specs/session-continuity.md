---
purpose: Existing Pi JSONL session trees remain the single conversation authority while inspire adds fast discovery, switching, continuation, and safe handoff.
covers:
  - shared/contracts.ts
  - server/session-catalog.ts
  - server/session-preview.ts
  - server/session-projection.ts
  - server/session-delete.ts
  - server/preferences.ts
  - server/resources.ts
  - server/runtime.ts
  - server/app.ts
  - src/api.ts
  - src/store.ts
  - src/session-drafts.ts
  - src/components/Composer.tsx
  - src/components/Nav.tsx
  - src/components/SessionDeleteDialog.tsx
  - src/components/Welcome.tsx
  - src/components/Transcript.tsx
  - src/components/BranchTree.tsx
  - server/session-tree.ts
  - tests/server/app.test.ts
  - tests/server/mock.test.ts
  - tests/server/session-delete.test.ts
  - tests/server/runtime.test.ts
  - tests/server/runtime-projection.test.ts
  - tests/server/session-projection.test.ts
  - tests/web/app.test.tsx
  - tests/web/nav-render.test.tsx
  - tests/web/store.test.ts
---

# Session continuity

## Goal

Let the user move between existing terminal Pi and inspire without losing history or learning a second session system.

## Checks

- inspire discovers sessions from the same Pi session storage selected by the user’s Pi configuration.
- A session can be listed, searched, opened, continued, named, and switched using Pi’s identity and tree rather than copied into another conversation store.
- Session listing reads bounded metadata and remains responsive without loading every full JSONL file into the browser. The host owns a deterministic newest-first filtered order plus validated bounded `offset`/`limit` and total. The browser keeps chronological base pages separate from curated/live hydration, advances only by `response.offset + response.sessions.length`, deduplicates identities without changing that cursor, and uses latest-wins reset semantics for query, curation, and explicit refresh. All id and cwd hydration unions are deduplicated and split within their host route bounds; authentication loss follows the shared auth boundary, while other partial hydration failures retain the last confirmed base/curated union and expose a retryable warning. A standalone selected/live lookup failure retries only its generation-bound id hydration and merges that row without changing the base extent; query or list refresh invalidates stale ownership. Older-page failures retain confirmed pages for retry. Settlement hints atomically refetch the already consumed extent in bounded sequential pages under one generation—even beyond one server page—and a failed retry retains and targets that exact extent instead of collapsing navigation back to page zero.
- Opening an unopened session first projects its active branch through Pi’s read-only parser and context builder, without waiting for extensions or writing the JSONL; transcript virtualization avoids mounting every entry in a large history at once.
- The independent Pi worker warms outside the selection critical path, and its `runtime_ready` event replaces the temporary preview with authoritative RPC state only if that session is still selected. After constructing the process but before starting it, the host reconciles the disk projection a second time and requires the captured identity, stat version, revision, tail, fingerprint, and committed bytes to be exactly unchanged. At the subsequent narrow Pi 0.83 startup boundary, Pi core may add one missing `thinking_level_change`, while installed extensions may persist non-transcript `custom` state from `session_start`. Readiness accepts only a strictly bounded, direct, contiguous append containing those entry classes after `get_entries`, `get_state`, and disk projection agree byte-for-byte on every entry, parent, final leaf, session, path, thinking level, and append lineage. Public RPC cannot causally distinguish Pi or extension initialization from a forbidden concurrent writer appending the exact same custom entry after the second baseline, so this is state attestation, not proof of authorship. The one-writer operating rule remains mandatory; wrong level or parent, messages, model changes, compactions, unsupported or oversized mixed deltas, changed file identity, and rewrites fail closed, and ordinary projection readers wait for attestation.
- Refreshing or reconnecting reconciles live events against an authoritative Pi snapshot without duplicating settled messages or letting a delayed snapshot replace a newer selection. If selection changes while the host is reading a snapshot, it retries against the new owner before sending anything authoritative.
- New sessions, naming, switching, compaction, same-file branch navigation, and forks use Pi’s supported runtime operations. Pi 0.83 reserves and reports a new session path immediately but deliberately does not create the JSONL until an assistant message exists; model, thinking, name, extension state, and the first user message can therefore remain only in the creating worker meanwhile. Only `newSession` may open a healthy empty projection for that absent path. The host reads the creating worker’s bounded contiguous `get_entries` state once to cover a file appearing during setup, then attests each complete-line prefix observed while the first file materializes; the parsed disk entries must be the worker state’s exact prefix and the current Pi header version, session id, cwd, root parent, entry chain, and physical append lineage must agree. Header-only and multi-write first flushes keep this single materialization transition open until disk catches the attested worker state. This verification does not depend on whether stdout message events or the filesystem notification arrives first: entries absorbed from disk before their event arrives are indexed by persistence correlation, matched by exact persisted payload, and consumed once. A mismatched first file fails closed and stops the worker; an ordinary existing-session open still treats a missing JSONL as an error. An unselected idle session that never materialized has no catalog identity to resume and may be abandoned by the existing worker LRU, while selected or running work retains its worker. Once materialized, the normal inode/version/append rules apply without exception. Once an RPC request frame has been written, timeout or child loss is an explicit acceptance-unknown outcome: the child is hard-stopped, disk is reconciled inside the operation lane, and the session remains conflicted rather than retrying or restaging prompt attachments. The branch tree is a bounded projection of Pi entry identities; switching creates a non-evictable in-memory navigation lease until the next append durably commits that branch, while edit-from-here moves to the selected user turn's parent and prefills the composer without submitting.
- Fork is one atomic runtime replacement: ordinary events are bounded and buffered until Pi reports the final destination identity, response-bearing hook dialogs remain source-addressable, the verified destination id/path is reserved before any awaited projection open, the old slot retains its processless read-only projection, the same child and only unresolved dialogs are rebound to the new slot, and a newer selection intent always wins. Catalog-driven destination opens wait on the reservation and can never spawn a competing worker. Fork is offered only on active-path user entries and never edits the source JSONL.
- Branch persistence mutations require an idle, fresh, conflict-free worker with no queued input or pre-existing dialog. Extension responses use a separate process-instance-validated per-slot FIFO, so navigation/fork hooks can await browser input without deadlocking the mutation FIFO and each accepted response is delivered exactly once. Stale revisions and ambiguous bridge outcomes fail closed; an unverified navigation stops the worker and reconciles disk instead of retrying.
- Every transcript snapshot/page carries an opaque branch-view generation plus its effective leaf. Explicit same-session navigation, worker reset, and non-append replacement change the generation; ordinary append continuation does not. Older-page cursors bind both view and effective-leaf lineage, and the browser aborts/discards a page that completes after a branch boundary.
- Each selected or active session owns an independent Pi runtime, and selecting another conversation changes only the browser projection; background runs continue without interruption. The writer baseline includes exact file identity/source version and observed physical bytes. Owned partial persistence must advance that same lineage by strictly growing bytes with exact prefix/tail continuity; same-byte rewrites and replacements fail closed. Unselected idle workers form a three-entry LRU warm cache and transparently restart from Pi’s session file after reclamation; busy workers, accepted prompts awaiting their lifecycle event, in-flight host operations, and workers awaiting or consuming extension input are never reclaimed. Reclamation drops the reloadable transcript projection as well as the child process.
- Navigation exposes current work and unseen completion per session: running, successful completion awaiting review, and error completion awaiting review remain distinct until the user opens that session.
- Persistent pin, folder-pin, hidden, and folder-collapse metadata belongs to inspire preferences, not Pi JSONL; pinned and hidden sessions are hydrated by id and a pinned folder by its working directory, so a pin stays reachable, a hidden session stays reversible, and a folder pinned as a whole stays a complete section — each bounded, and none of them dependent on falling inside the first chronological catalog page.
- Session deletion is exposed only as the second action tier inside Hidden and requires a target-naming confirmation. The browser sends only the bounded session id; the host requires exactly one matching record when it refreshes the Pi catalog before and after retiring any idle unselected slot, and rejects selected, opening, running, queued, compacting, retrying, dialog-blocked, persistence-unknown, branch-leased, forking, or conflicted ownership. The catalog-authorized path must be a non-symlink `.jsonl` regular file whose first record is the matching Pi session header and whose device, inode, size, mtime, and ctime remain unchanged through validation. Deletion follows Pi's picker semantics: move to desktop Trash first, and only after a failed Trash command revalidate the exact file version before permanent unlink; a missing source after an errored Trash command is reported as trashed rather than retried. The result distinguishes `trashed` from `deleted`; success clears catalog, resource handles, browser drafts/status, and navigation identity without touching project files or separately stored forks. If durable preference cleanup fails after the file outcome is known, the response marks that failure and the browser warns without retrying the destructive operation. The host cannot prove that an external terminal Pi process has no open descriptor, so the confirmation carries that warning and the one-writer operating rule remains mandatory.
- A dialog request raised by a background extension remains attached to its owning worker and is restored when that session is viewed; responses carry both session and request identity so concurrent navigation cannot misroute or orphan required input. A new-session worker is registered under a host-only provisional identity before startup begins, then atomically rebound or unregistered; shutdown stops and drains provisional workers before returning and provisional ids never leave the host, so early extension questions stay answerable without escaping lifecycle ownership.
- inspire never starts a second worker for a session it already owns and does not modify session JSONL directly while a Pi runtime owns it.

## Non-goals

- The product does not coordinate independent Pi runtimes as concurrent writers for one session.
- A derived search index, when introduced, is rebuildable and never becomes conversation authority.
