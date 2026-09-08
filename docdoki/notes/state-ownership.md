# State and operation ownership

## Resource and terminal addressing

### A resource read belongs to its addressed session

Global Host selection is not permission to resolve another browser's resource. `RuntimeReadController`
uses the requested open slot; context reconciliation and lazy message reads retain slot-registration,
view and revision checks without selecting it globally.

Content requests currently share the project-index discovery cache and in-flight scans.
Branch, canonical-path and pinned-object checks still belong to each addressed read; a
missing served file invalidates discovery. Current contract: [[resource-preview]].

### Partial terminal receipts are not complete catalogs

`TerminalCatalogController` belongs to one project/reload generation. Full reads and mutation
receipts share project, epoch and revision ownership. A partial receipt advances the revision
high-water mark, not complete membership: an equal-revision full response still reconciles order
and membership. An epoch change requires a full catalog; replaced epochs cannot return.

Obsolete success, failure and finally callbacks cannot change current selection, errors or loading
state. Optimistic rollback restores only its exact unchanged state. `tests/web/terminal-pane.test.tsx`
uses delayed APIs for A → B → A, reload, stale polling, partial receipts and equal-revision full
reconciliation; terminal rendering is stubbed for these ordering cases. Contract: [[terminal]].

### File URL conversion is platform-specific

A Windows drive URI retains an extra leading slash if its URL pathname is treated as a filesystem
path. Convert through a file URL and Node's native URL-to-path conversion instead. The Windows-path
suite exercises the parser with Node's Windows algorithms on Linux; it establishes parsing, not
native Windows filesystem or PTY behavior.

Sources: `server/runtime-reads.ts`, `src/terminal-catalog.ts`,
`tests/server/resources-windows-paths.test.ts` and `tests/server/resources.test.ts`.

## Responsibility-focused simplification

### Remove a layer when it adds no owner

The former stateless `RuntimePendingController` forwarded one operation through callbacks while
`RuntimeController` already owned mutation, writer admission and acceptance-unknown handling. Removing
that facade simplified the dependency path without moving authority. Likewise, independent Fork
creates a destination rather than transferring the source worker or dialogs, so fork-era `rebind`
helpers had no remaining role.

This is a reason to inspect responsibility, not a rule against controllers: event sockets and
terminal gateways each own an independent transport lifecycle and justify their modules.

### Split by responsibility, not line count

`server/runtime-event-sockets.ts` owns event interests, snapshots, batching and subscription cleanup;
`server/terminal-gateway.ts` owns terminal routes, tickets and socket attachments. Authentication and
Host shutdown remain in `app.ts`. Neither extracted module owns another transcript, runtime or PTY
registry.

The original 108 store tests were divided by their existing concerns—connection/events, transcript,
navigation, resources, composer/commands and deletion—with only setup shared. Partitioning by those
boundaries preserves discoverability without creating a large generalized fixture layer.

Persistence and incremental projection invariants can cross methods. A large runtime/projection
file therefore needs an identified responsibility boundary, not a mechanical size-based split.

### Keep contracts and experiments in their own homes

Root specs link to detailed contracts by authority: persistence/transport/branches/deletion,
Host lifecycle, workspace/preferences, and activity presentation. A short overview is navigation,
not a duplicate implementation or check ledger.

The retired performance evaluator had drifted into another fake protocol implementation and its
source-string verifier no longer matched the renderer. [[performance]] retains measurements
and exact reproduction points; maintaining obsolete executable fixtures was not necessary to keep
that knowledge.

### StrictMode can recapture a dialog's internal focus

Layout-effect replay can capture an already-focused internal Close button as the restoration target.
On unmount, focus then falls to the document body rather than the outside opener. `useModalFocus`
retains the previous entry's outside opener when replaying the same dialog with focus still inside.
The existing modal stack and stale-microtask ownership remain intact.

An isolated regression failed before the correction; the three affected browser flows then restored
the opener. Source: `src/use-modal-focus.ts` and `tests/web/modal-focus.test.tsx`.
