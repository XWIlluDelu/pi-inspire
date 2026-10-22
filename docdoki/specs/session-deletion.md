---
purpose: "Session deletion is a deliberate second-tier Hidden action whose entire target set passes pinned-object and ownership preflight before destructive I/O."
covers:
  - server/{runtime-session-deletion,session-delete,desktop-trash,linux-trash,macos-trash,session-recovery,session-recovery-entry,attachments,attachment-retention-identity,attachment-retention-entry,storage-volume,preferences}.ts
  - inspire.mjs
  - server/runtime.ts
  - src/controllers/session-management-controller.ts
  - src/components/{HiddenClearDialog,SessionDeleteDialog}.tsx
  - tests/server/{session-delete,desktop-trash,desktop-trash-native,native-session-trash-smoke,linux-trash,macos-trash,session-recovery,session-recovery-launcher,runtime-session-deletion}.test.ts
  - tests/server/*attachment-retention.test.ts
  - tests/server/{attachment-retention-identity,attachment-retention-entry,attachment-retention-launcher,storage-volume}.test.ts
  - tests/fixtures/attachment-retention-lock.ts
  - tests/web/{store-deletion,session-deletion-recovery,nav-render}.test.ts*
---

# Confirmed session deletion

## Goal

Delete only explicitly confirmed Pi session files while preserving active work, unrelated project
files, and newer browser preferences. Navigation curation remains in [[session-continuity]] and
[[workbench]].

## Confirmed deletion and all-target preflight

- Session deletion is exposed only as the second action tier inside Hidden and requires a
  target-naming confirmation. The confirmation identifies the exact session with the compact
  single-line title treatment, does not repeat unlabeled project metadata already established by the
  navigation context, and separates the Trash outcome, permanent-delete fallback, and non-cascading
  fork/project-file scope into three explicit lines. The browser sends only the bounded session id;
  the host resolves it from its last known catalog projection and keeps a catalog-wide scan out
  of the normal individual interaction path, then relies on the deletion adapter's path-local
  inode/version/header revalidation immediately before its Trash-first operation.

  Viewing an idle session does not block deletion. The host retires its owned idle worker and
  suspends projection reads before moving the file. Failure resumes the retained projection;
  committed deletion releases it and clears only that session's selection. The browser returns to
  New session only if it is still displaying the deleted identity; a newer open/new intent survives.
  The browser fences older projection refreshes and pauses new reads of the confirmed targets
  while deletion is in flight. Completion refreshes a still-selected surviving target, including
  after partial batch failure; a committed deletion does not leave a stale refresh banner.
  Authentication failures retain their transport-wide meaning rather than being suppressed as
  deletion noise.

  Selection-reserved, running, queued, compacting, retrying, dialog-blocked, persistence-unknown,
  branch-leased, forking, and conflicted ownership still blocks deletion. An already-owned worker
  warmup is awaited and then retired inside the single-session deletion lane. After deletion, the
  host removes the id from persistent hidden and pinned metadata so navigation state cannot outlive
  the session. The
  catalog-authorized path must be a non-symlink `.jsonl` regular file whose first record is the
  matching Pi session header. For individual deletion, the catalog pins device/inode rather than
  historical size/timestamps: after writer retirement, inspection pins the current version so normal
  conversation writes do not require a browser refresh. Device, inode, size, mtime, and ctime must
  then remain unchanged through validation. Hidden batch deletion instead retains the exact catalog
  version authorized by its all-target preflight.

  The inspected public `.jsonl` directory entry is atomically renamed into a private sibling
  quarantine on the same filesystem and its moved inode/version is revalidated. Desktop Trash
  receives only that identity-bound payload, or its private recovery bundle on Windows/macOS;
  the original pathname is recorded separately, never used as the native deletion source. Linux
  uses Freedesktop Trash restore metadata. Windows/macOS recovery is described below. The operation
  never restores a quarantined payload through the old public pathname: an absent private entry after a Trash report is a committed `trashed`
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
  forks. Ordinary uploaded files follow [[composer]] reference retention: Trash preserves their
  references, a surviving fork or branch prevents reclamation, and permanent deletion releases
  only the deleted session's references. Private indeterminate-deletion payloads also retain files;
  attachment collection runs in the background after each committed deletion, outside the response
  and Hidden-batch critical paths. Deferred or failed collection is recorded diagnostically, not
  returned as a deletion failure; periodic sweeps can retry it. Host shutdown still drains active
  collection. A collection outcome cannot turn committed deletion into a retryable operation.

  If durable preference cleanup fails after the file outcome is known, the response marks that
  failure and the browser warns without retrying the destructive operation. Observed external Pi
  activity never blocks deletion, including working or input-blocked terminals connected through
  Herdr. In-flight Host submissions, commands and interruption retain their operation barriers;
  native activity does not bypass reservations, conflicts or file-identity checks. A confirmation
  whose targets include an observed or connected terminal adds the short consequence that Pi may
  write again, including when the optional activity reporter is absent. No extra confirmation or
  external-process shutdown is imposed. Unobserved terminals do not add a generic warning. This
  does not change the one-writer rule for continuing a session.
  The top-level Hidden drawer exposes one count-bearing Clear action over its complete hydrated
  selection; search and incomplete curation hydration cannot admit it. The reviewed identity set includes both
  individually hidden sessions and every catalog session whose exact cwd is curated as a hidden
  folder.

  At route admission the host reads the current curation, then takes a fresh complete catalog
  snapshot and reconstructs that union itself. Unavailable sources reject this complete-set operation
  before any move, even though ordinary browsing and path-local single deletion remain available; changed membership rejects before any move rather
  than omitting an off-page target or silently expanding the confirmation. It reserves every target
  identity and rejects the entire batch before any move if a target is opening, running, queued,
  dialog-blocked, persistence-unknown, branch-leased, forking, or conflicted. Once admitted,
  it reports an exact committed subset if a later filesystem failure prevents completion; full
  success removes the reviewed individual and folder curation, while a partial result removes only
  committed session identities and keeps folder curation for what remains.

  A changed reviewed set, missing or replaced deletion source, or partial batch result retires the
  current confirmation. The browser refreshes the catalog and authoritative curation while preserving
  newer field-owned preference edits and the consumed chronological extent. The dialog offers
  **Review Hidden** instead of another destructive attempt against its old targets; deletion requires
  a new target-naming confirmation. An already absent session disappears from the refreshed list
  without claiming a Trash or permanent-delete outcome. Recovery never automatically repeats a
  DELETE or clear request, and ordinary busy/ownership refusals retain their existing protections.

## Native Trash and original-path recovery

Linux uses Freedesktop Trash on the source mount and retains its standard original-path restore
record. The home Trash is used only on that same mount; otherwise a current-user private directory
inside validated sticky `.Trash`, or private `.Trash-<uid>`, supplies volume-local Trash. Volume-local
restore paths are relative to that mount's top directory. Bind mounts retain distinct mount identities.
Unsafe directories, symlinks or unsupported moves fail before payload consumption and leave the
existing identity-checked permanent-delete fallback in charge.

On Windows and macOS, deletion
instead sends a visible **Inspire session recovery** folder inside the private quarantine to the
native Recycle Bin / Trash API. It contains the exact session JSONL, a versioned recovery manifest,
and a plain-text README with the original path and installed/source launcher commands. The manifest
records the original physical directory path (resolved before a configured alias can change), payload basename, Pi session id/cwd, byte length, and SHA-256
digest. The digest verifies the payload after OS restoration or cross-volume copying, when inode
identity legitimately changes; it is not a signature or authority to accept arbitrary manifests.

Windows uses the documented .NET Recycle Bin directory operation; macOS uses Foundation's
`FileManager.trashItem` through the system JavaScript bridge, including native per-volume placement.
Inspire does not edit private Recycle Bin records or Finder metadata to forge an original location.
Native **Restore / Put Back** can return only the private folder, not the original Pi session.
The deletion confirmation and operator guidance must not promise one-click original-path restore.

Recovery is explicit: restore the complete folder from Recycle Bin, or drag it out of macOS Trash,
then run `inspire recover-session "<bundle-folder>"`. The README also gives the exact local
`node <inspire.mjs>` command. This command runs without starting a Host or Pi worker and:

- Requires a bounded, supported manifest and regular non-symlink manifest/payload files. A
  symlinked bundle, basename traversal, header mismatch, changed source version, or mismatched
  size/digest rejects recovery.
- Copies from a pinned opened payload into a newly private directory on the destination filesystem,
  syncs the complete copy, and revalidates the source inode/version and payload digest. A source
  bundle on another volume is supported without publishing an incomplete public JSONL.
- Requires the original storage directory to remain available without symlink components; it does
  not invent missing storage trees. A complete verified copy is atomically published with
  no-replace hard-link creation. Every existing destination, including a symlink or a session
  concurrently recreated by Pi, wins without being overwritten.
- Preserves the complete selected bundle after success and reports that it can be removed after
  checking the recovered session. Private staging cleanup cannot undo a committed publication.
  Recovery restores the session file only, not Hidden/pinned preferences or a running Pi process.

The existing all-target, public-to-private quarantine and fresh-name purge checks still apply.
Native Trash failures that leave the exact private payload allow the normal permanent-delete
fallback; a modified or replaced payload remains isolated. After a committed outcome, cleanup
removes only fixed recovery metadata and empty private containers, never unknown entries or a
replacement payload. Upload retention continues to find session references recursively inside
native Trash bundles and indeterminate quarantine folders. On macOS this includes the home Trash
and current-user `.Trashes/<uid>` on volumes holding known session roots, resolved through
Foundation's documented volume-URL resource rather than a mount-table or arbitrary directory crawl.
Linux retention includes both standard layouts on known source mounts. Windows resolves storage
aliases and actual mounted-folder volume roots before choosing current-user Recycle Bin directories.
An unreadable or unidentified candidate volume defers collection instead of supplying negative
reference evidence. If a user moves a recovery folder outside known session/Trash roots, recover it
promptly: an arbitrary external folder is not a retention root.

## Retention storage continuity and migration

Negative reference evidence requires both the registered session namespace and its native Trash
volume to remain identifiable across Host restarts. Path existence, a valid current Pi header,
device numbers, inode numbers and Linux mount topology alone do not establish that continuity.

Read-only history opening observes its directory in memory without requiring retention storage
writes. Before collection, the Host registers any such observed directory; registration failure
defers collection rather than blocking history. Writer admission and new retained references keep
their durable-registration requirement.

Each registered long-lived session directory has a non-secret
`.inspire-upload-retention-root.json` UUID sidecar. Inspire never changes Pi JSONL to establish
retention identity. Marker creation uses exclusive no-clobber creation and sync; bounded reads pin
the regular non-symlink file and revalidate its inode/version and containing directory. Every sweep
checks the marker before and after reference scanning. A missing, malformed, changed, unsafe or
unreadable marker defers collection; normal session registration never recreates or replaces an
already-registered marker automatically.

A copied session marker is not sufficient: native Trash lies outside the session directory. The
registry also records an independent volume proof:

- **Windows:** the documented volume GUID path plus the filesystem serial returned by
  `GetVolumeInformationW`. The combination detects ordinary filesystem reformatting even when
  Mount Manager preserves the GUID. `GetVolumePathNameW` resolves mounted-folder volumes rather
  than assuming a drive-letter root. UNC/storage without a verified local GUID and format proof
  defers collection.
- **macOS:** Foundation's `volumeUUIDStringKey`, not the mount-lifetime `volumeIdentifierKey`.
  Unsupported or unavailable filesystem UUIDs defer collection.
- **Linux:** an independent private random anchor on the same current filesystem, outside the
  session directory **and its entire subtree**. Inspire first uses private metadata under the
  actual attachment-state parent when it shares that filesystem. An external filesystem can use
  `.inspire-retention-<uid>` at its known mount top directory. The anchor is never placed in Trash.
  Device values only check current same-filesystem placement; they are not persisted as identity.
  The anchor UUID and location persist, together with mountpoint/root scope so a changed bind
  subtree cannot hide its previous Trash. No Python, privileged block-device access or new-kernel
  UUID ioctl is required. If no safe independent writable location is available, first binding
  remains unknown and collection pauses. Existing readable markers/anchors can be checked without
  writing to the source filesystem.

Windows/macOS UUID queries run in bounded, ordered batches before and after a complete sweep.
Character/byte and root-count budgets keep long root collections below native environment/argument
and output limits. Opening an already-registered session does not spawn another native volume query.

Copying only a session directory, including its marker, onto replacement storage cannot authorize
collection against an empty replacement Trash. A complete filesystem namespace clone can preserve
its UUID or anchor; it must preserve the original Trash references too. These are storage-namespace
identifiers, not hardware attestation or protection against deliberate identifier cloning.

The version-3 upload registry preserves all registered paths and binds marker IDs to volume proofs.
Legacy arrays, version-2 mount-only registries and marker-only records lack sufficient historical
evidence and remain unverified. Current directory/Pi-header contents do not silently migrate them.
A conflicting or unverified sibling registry also prevents negative evidence; another Host's
verified record cannot legitimize it automatically. New registration remembers the unknown path
before attempting marker/volume binding. Read-only or failed identity setup pauses collection,
not ordinary session opening, sending or deletion. Registry persistence errors retain their existing
visible failure behavior.

An unused missing default/configured root remains optional. Actual validated uploaded-file
references discovered outside registered storage cause the corresponding long-lived storage root
to be remembered before a later sweep can reclaim uploads. Catalog-path existence alone creates no
identity authority. Native Trash/recovery folders and private deletion-quarantine subdirectories
are never registered as long-lived marker roots. Removing a registered directory, even a Linux
subdirectory on an otherwise mounted volume, now defers collection until storage continuity is
restored or explicitly accepted.

Operator recovery uses:

```sh
inspire uploads trust-session-directory "<absolute-session-directory>"
inspire uploads trust-session-directory "<absolute-session-directory>" --confirm
# Only for a deliberately verified replacement namespace:
inspire uploads trust-session-directory "<absolute-session-directory>" --confirm --accept-replacement
```

Preview makes no changes and shows previous/current identities. Confirmation asserts that the
directory and its volume contain the complete original session **and native Trash references**
that must be retained; mistaken trust can release uploaded files. Ordinary confirmation binds
legacy/unknown storage or repairs missing markers/anchors, reusing a consistent expected random ID
where available. A different existing valid marker or volume proof requires the additional
replacement flag. Replacement acceptance updates registry expectations, never overwrites valid
marker or anchor contents, and still requires a currently verified volume proof. Missing storage
trees are not invented. Partial/corrupt metadata is not silently reset.

Migration covers every affected registry in the same actual attachment-state parent. All Hosts
sharing that parent must be stopped. A parent-wide exclusive maintenance gate coordinates current
Host lease publication, normal registry writers and explicit trust. The established file-lock
protocol uses a kernel lock on Linux and process-birth-bound participants elsewhere, so a crashed
owner does not leave a permanent global gate. New Host leases and upload-owner metadata record
process-birth identity; a reused PID alone cannot keep a stale known owner active. Unavailable
birth identity and old/unknown metadata remain conservative. Legacy default-root Host PIDs supply
an additional check, but finite legacy PID evidence cannot prove that every mixed-version Host has
stopped. Offline migration therefore remains an operator requirement, not a claim of complete
old-version concurrency control. Registry replacement is atomic per file; partial multi-registry
failure leaves unknown/conflicting evidence deferred and can be resumed explicitly after correcting
the operational failure.

### Native API references

- [Freedesktop Trash specification](https://specifications.freedesktop.org/trash-spec/latest/)
  defines home/volume-local layouts, current-user directories and restore-path metadata.

- [Windows FileSystem.DeleteDirectory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.visualbasic.fileio.filesystem.deletedirectory)
  supplies `SendToRecycleBin` but no independent original-location override.
- [Apple FileManager.trashItem](https://developer.apple.com/documentation/foundation/filemanager/trashitem(at:resultingitemurl:))
  moves the supplied item to native Trash, not an independently named restore path.
- [Apple volumeURLKey](https://developer.apple.com/documentation/foundation/urlresourcekey/volumeurlkey)
  identifies the mounted volume holding each known session root.
- [Apple volumeUUIDStringKey](https://developer.apple.com/documentation/foundation/urlresourcekey/volumeuuidstringkey)
  supplies the filesystem UUID used across restarts.
- [Windows GetVolumeNameForVolumeMountPointW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumenameforvolumemountpointw)
  supplies the mounted volume GUID path.
- [Windows GetVolumeInformationW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationw)
  supplies the format-time filesystem serial used together with that GUID.
- [Windows GetVolumePathNameW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumepathnamew)
  resolves the actual volume mount root for a filesystem path.
