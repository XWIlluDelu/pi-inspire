---
purpose: "Pi owns branch semantics while same-file navigation and isolated fork creation retain explicit revision, writer, and publication boundaries."
covers:
  - server/runtime.ts
  - server/runtime-branch*.ts
  - server/session-{tree,projection,fork,fork-worker,export}.ts
  - server/generated-exports.ts
  - server/extensions/inspire-branch-bridge.ts
  - shared/{branch-node-actions,branch-bridge-protocol}.ts
  - src/controllers/branch-controller.ts
  - src/components/{BranchTree,SessionActionsMenu,EarlierBranchBanner,AppTopbar}.tsx
  - server/attachments.ts
  - shared/contracts.ts
  - src/store.ts
  - src/controllers/composer-controller.ts
  - tests/server/{runtime-branching,session-tree,branch-bridge-extension,session-export.integration}.test.ts
  - tests/server/{runtime-branch-bridge,pi-branch-bridge.integration}.test.ts
  - tests/web/{branch-controller,branch-store}.test.ts*
  - tests/browser/history.spec.ts
  - src/styles/{history,transcript}.css
---

# History, branches and independent copies

## Goal

Inspect Pi history without changing the active conversation merely by browsing. Deliberately
navigate, edit from, Fork or Clone native paths without inventing alternate branch semantics.
Independent copies preserve the source worker. [[session-persistence]] owns durable trust and writer
admission; [[session-transport]] owns browser continuity and observation lifetimes.

## Saved branches, reading, and copying

**Switch branch…** in the title menu and `/tree` open the same saved branch list. Each choice
corresponds to a Pi leaf and shows its latest user prompt. Clicking a choice enters that branch
under the current revision and writer admission. Fork remains available on the original user
message and Clone remains available in the title menu.

The right-side **History** tab and **Open History** in the palette open the native branch outline.
The outline groups replies and activity by user input. It can search a literal phrase across
saved branches and preview another route or an individual point without moving the active branch.
Returning from detail restores the outline query, expansion, scroll position and opener. The
selected point offers the applicable same-session continuation, Edit, Fork and Clone actions.
The outline and entry reads use the existing view-addressed History endpoint. Saved pages also
read through the conversation scrollport and Prompt Map under [[conversation]].

Copy and image reads bind to the selected immutable entry and transcript view throughout.
The Host delivers long text in bounded chunks and returns images in their original part order.
Leaving the view retires its reads. Shell Copy includes retained command, status and output.
The authorized full-log button resolves Pi's separate file reference.

## Same-file navigation

Use supported Pi operations for naming, switching, compaction and navigation. Native edit moves
before the selected entry and returns its text without submitting, including a root user's null
parent and native custom-message targets. Successful targets need not become the resulting leaf.

Watch uses the same addressed navigation command and carries the inspected branch revision. It
selects a readable saved route and can observe an external Pi while leaving an unstarted local
worker cold. Switch and Edit retain their native mutation admission and use the inspected revision.

Navigation requires an idle, fresh, conflict-free worker with no queued input or pre-existing dialog.
Reject native shell requests while navigation is pending, including while an extension hook awaits
input. The worker's native branch determines its eligibility for idle reclamation. If it has
moved away from the file's current leaf, the view offers the address of that saved position.

Branch switching is reversible and non-destructive. Edit-from-here confirms only when replacing a
nonempty Composer draft. Capture that draft's text/material revision; returned text may replace only
that revision. Text, attachment or reference edits during navigation/summary remain intact, even
when text later equals the confirmed draft. Navigation still commits under session/view/request
ownership.

### Native bridge and callbacks

Same-file navigation uses stock Pi RPC through one Inspire-owned extension. Each worker receives
randomized command, status-key and worker identities. Accept one bounded nonce-correlated `setStatus`
result, await both it and prompt completion, and independently verify the final leaf and persisted
Pi effects, including branch-summary appends and before-target/null leaves.

A synchronous read-only `session_tree` observer captures the native anchor before callback appends;
the completed result also carries the effective leaf. Worker entries and disk must agree on the
contiguous native summary/label prefix and callback chain from that anchor. Valid `custom` and
`custom_message` callbacks may become the leaf; their parent need not be the pre-navigation leaf.
Intermediate appends require same-worker witnesses even while a later hook awaits a dialog. Final
acceptance retains nonce/worker/session, handler-completion and disk checks.

The internal command is hidden from completion and rejected at the public prompt boundary.
Handler completion without its matching result is a protocol failure, not an indefinite wait.
Missing, duplicate, malformed, stale or mismatched results are never retried after possible effects.
Stale revisions and ambiguous outcomes fail closed. An unverified navigation stops the worker and
reconciles disk instead of retrying.

Extension responses use a separate process-instance-validated per-slot FIFO. Hooks can await input
without deadlocking the mutation lane, and each accepted response is delivered once.

### Native branch summary

The History point actions show the option to carry Pi's branch summary for same-session
continuation where Pi permits it. Summary is off by default. Enabling it reveals optional
instructions. Cancellation follows Pi's outcome and leaves the original branch selected.

## Independent Fork and Clone

### Source admission and destination input

Fork addresses a retained user entry by session id and transcript view; the entry need not be on the
active path or current History page. Clone captures its endpoint when invoked, including an explicit
empty effective path, rather than choosing the latest leaf on arrival.

Require materialized current-format JSONL, a conflict-free reading projection and an available
inherited project folder. Validate view and target after reconciliation. Normal tail appends do not
invalidate them; no matching branch revision or preparatory History refresh is required.
Source activity, writer ownership, Pending queues, dialogs and the Host's global selection do not
block copying because no source command or replacement occurs. Sessions another Pi is running may
be copied.

Pi determines ancestry, labels, metadata and the generated identity:

- Fork excludes the selected user message and returns it as the destination draft, with text and
  saved images in original order/multiplicity. Restage image bytes from the admitted projection as
  independent private attachments; original upload handles and file paths are unnecessary. Return
  handles/metadata rather than Base64. Use ordinary Composer thumbnails, preview, removal and
  explicit send, including image-only input. Message-wide limits apply at send time so users can
  trim oversized drafts. Invalid, unsupported or individually oversized images reject Fork instead
  of silently dropping content. Failed publication/attachment and retired browser responses withdraw
  their unclaimed staged copies.
- Clone includes its endpoint, or produces native header-only JSONL for an empty path, and opens an
  empty destination Composer.

Neither action sends a model prompt or transfers the source's unsent draft/artifacts or pending input.

### Snapshot and publication

Capture a fresh conflict-free committed source prefix and retained endpoint. A worker thread reads
and hashes exactly that prefix through the shared JSONL reader, applies Pi's entry migration in
memory, and runs the installed Pi's in-memory `SessionManager` branch operation. The real source
path supplies parent provenance. The thread writes the complete destination into private staging,
including header-only output. Source work and pending input continue while the copy runs.
Appends and partial trailing writes beyond the admitted prefix stay outside the copy.

Before publication, open the private projection, reserve the generated id/final path, and recheck
the source view. Publish the complete JSONL atomically without replacement, reopen under that reservation, and attach a processless
destination. Viewing the copy stays processless until a worker-backed action. Concurrent
open/create/delete shares the reservation;
catalog-driven opens wait for it. Destination attachment is independent of Host selection.

The response always identifies the destination. Change automatic Host selection only if the source
is still selected and no newer selection intent arose since dispatch, including while awaiting the
source operation lane. Pre-publication failure removes staging; post-publication failure identifies
the committed destination rather than inviting blind retry.

## Browser action ownership

History reads and branch actions belong to the initiating browser visit and view. Navigation uses
the revision from the entry the user inspected; the Host rejects stale versions. If the socket
already published that exact result, the HTTP response can still offer the returned draft. It
cannot replace a newer draft or a different visit. Independent copies bind the admitted source
prefix, so ordinary source appends do not prevent the published destination from opening.

Current-branch Clone failures use the visible notification stack even when History is closed;
node-specific actions keep their local error/retry surface.

## Export content and publication

HTML preserves Pi's whole tree. JSONL preserves the active branch's original native entries, embedded
images and metadata, with a current native header and linear parents. Context edits affect model
context, not exported raw history. Export never switches the source manager or worker.

Capture content available at invocation, including during active work, without locking later input
or promising a completed answer. JSONL reuses the verified local prefix plus native suffix/effective
leaf when an owned worker is connected; unmaterialized sessions use their worker's entries.
Otherwise serialize verified saved entries and effective leaf without launching Pi, including when
the workspace or external owner is unavailable. Label this saved history; unsaved native output is
outside its snapshot.

Typed `/export` retains Pi's one-path parsing, including quoted spaces and `~/`. A `.jsonl` suffix
selects branch JSONL; other destinations use native HTML. Refuse the canonical source and its
symlink/hardlink aliases. HTML and Reload require writer admission; saved JSONL requires only a
healthy conflict-free reading projection. Read-only menus keep Export available with JSONL and
disable Rename. Fork/Clone keep independent-copy admission across the title menu, palette and
current-branch action.

Graphical Export captures a private managed download and removes temporary native source files on
success or failure. Authenticated, session-owned opaque ids serve those snapshots, not caller-selected
Host paths, and later output cannot retarget them. Retain at most 16 downloads for 24 hours, remove
them on shutdown and require re-export after Host restart. Failed allocation stays retryable and
all acquired handles close. [[composer]] owns the dialog and typed receipts.

## Earlier-branch presentation

When a verified navigation leaves the worker on an earlier branch, show a compact notice in the
shared top-right notification stack. It explains where the next message continues.
**Continue from latest saved point** uses the confirmed snapshot revision to change that continuation. If
the saved point is a user or custom message, restoring it retires the idle owned worker and the next
local action opens Pi at the exact saved point. Other branch ends that Pi can only edit are still
available through **Edit from here** in History.
The notice is available with History closed. Dismissing it hides it for the current view and leaves
the continuation in place. The command palette still offers the restore action. **Clone current branch**
in the session menu copies through the displayed point without changing the source session.

Use the Host's verified navigation lease and durable/effective leaf pair for this presentation.
Ordinary differences while the worker and saved history update independently do not qualify,
including while following an attached Pi or viewing a saved session. The notice floats below the
conversation tools and leaves the reading viewport in place.
