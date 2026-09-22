---
purpose: Explain session-addressed resource reads, project-owned terminal receipts and platform-correct file URI conversion.
---

# Resource and terminal addressing

## A resource read belongs to its addressed session

Global Host selection is not permission to resolve another browser's resource. `RuntimeReadController`
uses the requested open slot; context reconciliation and lazy message reads retain slot-registration,
view and revision checks without selecting it globally. This is the same ownership distinction as
[[async-ownership-review]].

Discovery and read authorization are separate. The former Git preview-index and ignore-rule expiry
policy was superseded by [[filesystem-git-separation]]: discovery may be cached, but content reads
check current workspace containment and the pinned object directly. [[resource-preview]] is the
current contract.

## Partial terminal receipts are not complete catalogs

`TerminalCatalogController` belongs to one project/reload generation. Full reads and mutation
receipts share project, epoch and revision ownership. A partial receipt advances the revision
high-water mark, not complete membership: an equal-revision full response still reconciles order
and membership. An epoch change requires a full catalog; replaced epochs cannot return.

Obsolete success, failure and finally callbacks cannot change current selection, errors or loading
state. Optimistic rollback restores only its exact unchanged state. `tests/web/terminal-pane.test.tsx`
uses delayed APIs for A → B → A, reload, stale polling, partial receipts and equal-revision full
reconciliation; terminal rendering is stubbed for these ordering cases. Contract: [[terminal]].

## File URL conversion is platform-specific

A Windows drive URI retains an extra leading slash if its URL pathname is treated as a filesystem
path. Convert through a file URL and Node's native URL-to-path conversion instead. The Windows-path
suite exercises the parser with Node's Windows algorithms on Linux; it establishes parsing, not
native Windows filesystem or PTY behavior.

Sources: `server/runtime-reads.ts`, `src/terminal-catalog.ts`,
`tests/server/resources-windows-paths.test.ts` and `tests/server/resources.test.ts`.
