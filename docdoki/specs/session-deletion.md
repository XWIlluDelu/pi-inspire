---
purpose: "Session deletion is a deliberate second-tier Hidden action whose entire target set passes pinned-object and ownership preflight before destructive I/O."
covers:
  - server/{runtime-session-deletion,session-delete,desktop-trash,linux-trash,session-recovery,session-recovery-entry,preferences}.ts
  - inspire.mjs
  - server/runtime.ts
  - src/controllers/session-management-controller.ts
  - src/components/{HiddenClearDialog,SessionDeleteDialog}.tsx
  - tests/server/{session-delete,desktop-trash,desktop-trash-native,native-session-trash-smoke,linux-trash,session-recovery,session-recovery-launcher,runtime-session-deletion}.test.ts
  - tests/web/{store-deletion,session-deletion-recovery,nav-render}.test.ts*
---

# Confirmed session deletion

## Goal

Delete only explicitly confirmed Pi session files while preserving active work, unrelated project
files, and newer browser preferences. Navigation curation remains in [[session-continuity]] and
[[workbench]].

## Confirmation and ownership

Deletion is a second-tier action inside Hidden. Confirmation names the exact targets and explains
Trash, the permanent-delete fallback, and the exclusion of project files and separately stored forks.
The browser submits bounded session identities; the Host resolves and validates their files.

Viewing an idle session does not block deletion. The Host awaits any owned-worker warmup, retires
its idle worker, and suspends projection reads in the session's deletion lane. Selection-reserved,
running, queued, compacting, retrying, dialog-blocked, persistence-unknown, branch-leased, forking,
and conflicted ownership blocks deletion.

External Pi activity does not block deletion, including working or input-blocked terminals connected
through Herdr. If a target has an observed or connected terminal, confirmation explains that Pi may
write again, including when its optional activity reporter is absent. Unobserved terminals add no
generic warning. Deletion neither adds another confirmation nor stops external Pi. In-flight Host
submissions, commands and interruptions retain their barriers, as do conflicts and file-identity
checks. Continuing a session still follows the one-writer rule in [[session-persistence]].

## Target validation

### Individual deletion

The normal path uses the last known catalog projection rather than a catalog-wide scan. Its target
must be a non-symlink `.jsonl` regular file beginning with the matching Pi session header. The catalog
pins device/inode; after worker retirement, inspection pins the current size, mtime and ctime.
Normal conversation appends therefore do not require a browser refresh, but the inspected object
and version must remain unchanged through validation.

### Clear Hidden

The top-level Hidden drawer offers a count-bearing Clear action over the complete hydrated union of
individually hidden sessions and sessions whose exact cwd is a hidden folder. Search and incomplete
curation hydration cannot authorize clearing.

At admission, the Host reads current curation, takes a fresh complete catalog snapshot, and
reconstructs that union. Unavailable sources or changed membership reject the batch before any move;
confirmation cannot silently expand or omit off-page targets. The Host reserves every identity and
checks the ownership restrictions above for every target before destructive I/O. Each target keeps
the exact catalog version authorized by this preflight.

A later filesystem failure reports the exact committed subset. Full success removes the reviewed
session and folder curation; partial success removes only committed session identities and retains
folder curation for the remaining sessions.

## File commit and outcomes

The validated public directory entry is atomically renamed into a private sibling quarantine on the
same filesystem. Its moved inode/version is revalidated before Desktop Trash receives that payload,
or its recovery bundle on Windows/macOS. The original path is restore metadata, never the native
deletion source. A quarantined payload is never restored through the old public pathname.

- After a Trash report, an absent private payload is a committed `trashed` outcome. A remaining,
  modified or replaced payload stays isolated and yields an indeterminate error.
- If Trash fails and the exact private version remains, permanent-delete fallback moves it into a
  newly created nested private purge directory, revalidates it, and unlinks only that fresh name.
  A change at either private pathname fails visibly and preserves the isolated payload.
- Neither a public nor private replacement can become a destructive target or enter the catalog.
  Once Trash or unlink commits, cleanup failure cannot turn it into a retryable deletion error.
  Cleanup removes only fixed recovery metadata and empty private containers, never unknown entries
  or replacement payloads.

Successful deletion clears the session's catalog identity, resource handles, browser draft/status,
and persistent Hidden/pinned metadata. Ordinary uploaded files remain durable assets under
[[composer]], including after permanent deletion or emptying native Trash. Asset cleanup is separate;
the deletion path has no reference scan or collection callback. If preference cleanup fails after
the file outcome is known, the response reports it and the browser warns without retrying deletion.

## Browser reconciliation

The browser fences older projection refreshes and pauses reads of confirmed targets during deletion.
Failure resumes the retained projection; committed deletion releases it and clears only that
session's selection. The browser returns to New only if it still displays the deleted identity;
a newer open/new intent survives. A surviving selected target refreshes after completion, including
partial batch failure, without leaving a stale refresh banner. Authentication failures remain
transport-wide.

A changed reviewed set, missing/replaced source, or partial batch result retires the confirmation.
Refresh the catalog and authoritative curation while preserving newer field-owned preference edits
and the consumed chronological extent. Offer review of the refreshed Hidden targets before another
target-naming confirmation. An already absent session disappears without claiming a Trash or
permanent-delete outcome. Recovery never repeats DELETE or Clear automatically; ordinary ownership
refusals retain their protections.

## Native Trash and original-path recovery

### Linux

Use Freedesktop Trash on the source mount with standard original-path restore metadata. Home Trash
applies only on that same mount; otherwise use a current-user private directory inside validated
sticky `.Trash`, or private `.Trash-<uid>`. Volume-local restore paths are relative to the mount's
top directory, and bind mounts retain distinct identities. Unsafe directories, symlinks and
unsupported moves fail before payload consumption, leaving the identity-checked permanent-delete
fallback in charge.

### Windows and macOS

Send an **Inspire session recovery** folder from the private quarantine to the native Recycle Bin /
Trash API. It contains the exact JSONL, a versioned recovery manifest, and a README with the original
path and installed/source launcher commands. The manifest records the original physical directory
(resolved before a configured alias can change), payload basename, Pi session id/cwd, byte length,
and SHA-256 digest. The digest verifies restored or cross-volume copies whose inode legitimately
changes; manifest and source validation remain required.

Windows uses the documented .NET Recycle Bin directory operation; macOS uses Foundation's
`FileManager.trashItem` through the system JavaScript bridge, including native per-volume placement.
Inspire does not forge private Recycle Bin or Finder restore metadata. Native Restore / Put Back
can return the private folder, not the original Pi session; confirmation and guidance must explain
that distinction.

Restore the complete folder from Recycle Bin, or drag it out of macOS Trash, then run:

```sh
inspire recover-session "<bundle-folder>"
```

The bundle README also supplies the exact local `node <inspire.mjs>` command. Recovery runs without
a Host or Pi worker and:

- Requires a bounded, supported manifest and regular non-symlink manifest/payload files. Reject a
  symlinked bundle, basename traversal, header mismatch, changed source version, or size/digest
  mismatch.
- Copies from a pinned opened payload into private staging on the destination filesystem, syncs the
  complete copy, and revalidates source inode/version and digest. Cross-volume bundles are supported
  without exposing incomplete JSONL.
- Requires the original storage directory to remain available without symlink components. Publish
  the verified copy atomically using no-replace hard-link creation. Do not create missing storage
  trees or overwrite any destination, including symlinks and sessions concurrently recreated by Pi.
- Preserves the selected bundle after success and reports that it may be removed after checking the
  recovered session. Staging cleanup cannot undo publication. Recovery restores only the file,
  not Hidden/pinned preferences or a running process.

The quarantine, version checks and outcome rules above also apply to recovery bundles. Delivered
attachments remain available independently of the bundle's location or accessibility; recovery
needs no upload registry, directory marker or volume-identity migration.

### Native API references

- [Freedesktop Trash specification](https://specifications.freedesktop.org/trash-spec/latest/)
  defines home/volume-local layouts, current-user directories and restore-path metadata.
- [Windows FileSystem.DeleteDirectory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.visualbasic.fileio.filesystem.deletedirectory)
  supplies `SendToRecycleBin` but no independent original-location override.
- [Apple FileManager.trashItem](https://developer.apple.com/documentation/foundation/filemanager/trashitem(at:resultingitemurl:))
  moves the supplied item to native Trash, not an independently named restore path.
