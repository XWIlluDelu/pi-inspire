---
purpose: "Session deletion is a deliberate second-tier Hidden action whose entire target set passes pinned-object and ownership preflight before destructive I/O."
covers:
  - server/{runtime-session-deletion,session-delete,preferences}.ts
  - server/runtime.ts
  - src/controllers/session-management-controller.ts
  - src/components/{HiddenClearDialog,SessionDeleteDialog}.tsx
  - tests/server/{session-delete,runtime}.test.ts
  - tests/web/{store-deletion,nav-render}.test.ts*
---

# Confirmed session deletion

## Goal

Delete only explicitly confirmed Pi session files while preserving active work, unrelated project
files, and newer browser preferences. Navigation curation remains in [[session-continuity]] and
[[workbench]].

## Checks

### Confirmed deletion and all-target preflight

- Session deletion is exposed only as the second action tier inside Hidden and requires a
  target-naming confirmation. The confirmation identifies the exact session with the compact
  single-line title treatment, does not repeat unlabeled project metadata already established by the
  navigation context, and separates the Trash outcome, permanent-delete fallback, and non-cascading
  fork/project-file scope into three explicit lines. The browser sends only the bounded session id;
  the host resolves it from its last complete catalog projection and keeps a catalog-wide scan out
  of the individual interaction path, then relies on the deletion adapter's path-local
  inode/version/header revalidation immediately before its Trash-first operation.

  It rejects ownership that is selected, selection-reserved, running, queued, compacting, retrying,
  dialog-blocked, persistence-unknown, branch-leased, forking, or conflicted. An already-owned
  background worker warmup that began before host deselection is awaited and then retired inside the
  deletion lane instead of producing a transient opening error. After deletion, the host removes the
  id from persistent hidden and pinned metadata so navigation state cannot outlive the session. The
  catalog-authorized path must be a non-symlink `.jsonl` regular file whose first record is the
  matching Pi session header and whose device, inode, size, mtime, and ctime remain unchanged
  through validation.

  The inspected public `.jsonl` directory entry is atomically renamed into a private sibling
  quarantine on the same filesystem and its moved inode/version is revalidated. Desktop Trash
  receives only that identity-bound payload; the original pathname is written separately as
  Freedesktop Trash restore metadata. The operation never restores a quarantined payload through the
  old public pathname: an absent private entry after a Trash report is a committed `trashed`
  outcome, while a payload that remains, changes version, or is replaced is retained in its private
  recovery location and returns an indeterminate error.

  If the original exact private version remains after a Trash failure, fallback moves it into a
  newly created nested private purge directory, revalidates that move, and permanently unlinks only
  that fresh name. Any payload change at either private pathname fails visibly and remains isolated;
  neither a public nor a quarantine replacement can be promoted into the Pi catalog or selected as a
  destructive target. The result distinguishes `trashed` from `deleted`; once the payload has moved
  to Trash or been unlinked, failure to remove its now-empty private container cannot turn that
  committed outcome into a retryable deletion failure. Success clears catalog, resource handles,
  browser drafts/status, and navigation identity without touching project files or separately stored
  forks.

  If durable preference cleanup fails after the file outcome is known, the response marks that
  failure and the browser warns without retrying the destructive operation. The host cannot prove
  that an external terminal Pi process has no open descriptor, so the confirmation carries that
  warning and the one-writer operating rule remains mandatory. The top-level Hidden drawer
  separately exposes one count-bearing Clear action over its complete hydrated selection; search and
  incomplete curation hydration cannot admit it. The reviewed identity set includes both
  individually hidden sessions and every catalog session whose exact cwd is curated as a hidden
  folder.

  At route admission the host reads the current curation, then takes one authoritative catalog
  snapshot and reconstructs that union itself; changed membership rejects before any move rather
  than omitting an off-page target or silently expanding the confirmation. It reserves every target
  identity and rejects the entire batch before any move if a target is selected, opening, working,
  queued, dialog-blocked, persistence-unknown, branch-leased, forking, or conflicted. Once admitted,
  it reports an exact committed subset if a later filesystem failure prevents completion; full
  success removes the reviewed individual and folder curation, while a partial result removes only
  committed session identities and keeps folder curation for what remains.
