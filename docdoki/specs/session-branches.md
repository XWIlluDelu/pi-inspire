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
  - src/components/{NativeTurnReader,EarlierBranchBanner,AppTopbar}.tsx
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

## History inspection

### Native pages, routes and search

History is the conversation's single native-turn reader. The title menu, command palette and
`/tree` open the same destination. Earlier and Later load bounded pages on one pinned branch.
Other routes shows the native siblings at a branch point; opening one reads its latest retained
leaf without moving Pi. Current conversation returns to the live branch's saved history. Search
matches the complete case-insensitive phrase anywhere on the selected saved branch, including
entries outside the mounted page. Native entry ID, saved branch and reading offset survive
reopening in the same browser tab. No message content or permission is stored with that location.

Ordinary user-input snippets use the shared user-content projection: readable file names replace
transport trailers, image-dimension notes are omitted, and image cues remain. Search snippets and
detailed reads expose retained source so path matching, Copy and editing remain possible.

Read complete retained entries in bounded chunks. Ordinary assistant/tool content stays rich;
native shell records show command, output, status and context inclusion as Shell activity rather
than system bodies or storage JSON. Live and History share the same Shell card. Saved output is
paged as literal text; structured command, exit and full-log metadata are separate from stdout.
History owns scrolling without a nested output viewport.

Shell Copy reads the complete retained entry, combining its structured metadata with every output
section. It does not copy a separate full-output file. The full-log button uses the authorized file
preview. Text printed in stdout never becomes that reference.
History text uses the same authorized file-preview actions as Transcript.

### Copy, images and read recovery

Each entry has a Copy action beside its preview.
Read all bounded text chunks and structured images without expanding or scrolling the preview.
Copy the retained record, not a separate full-output file or loaded excerpt. Image formats, ordering,
plain-text alternatives and clipboard failures follow [[design-system]].

Copy and image reads bind to the selected immutable entry and transcript view throughout. Leaving
the entry/source cancels copying. Image coordinates remain Host-resolved and cancellable; saved
images use the shared viewer with pointer/keyboard opening, fit/zoom, close and focus return.
Render structured images separately from descriptive placeholders and preserve user-written text
that resembles a placeholder.

Entry/image reads survive ordinary same-view appends. Navigation and source/worker/view replacement
retire them; same-file mutations still require a fresh revision. Retiring a read also retires its
progress, without letting an old completion clear newer progress.

Each replacement page, route list or body belongs to one cancellable read. Failures leave the last
confirmed page visible and offer Retry. Entry and image reads use bounded backoff for transient
failures. Recovery never repeats navigation, Fork, Clone or clipboard copying.

## Same-file navigation

Use supported Pi operations for naming, switching, compaction and navigation. Native edit moves
before the selected entry and returns its text without submitting, including a root user's null
parent and native custom-message targets. Successful targets need not become the resulting leaf.

Navigation requires an idle, fresh, conflict-free worker with no queued input or pre-existing dialog.
Reject native shell requests while navigation is pending, including while an extension hook awaits
input. Deliberate switching creates a non-evictable in-memory navigation lease until the next append
durably commits that branch.

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

### Optional branch summary

A deliberate same-session continuation may carry Pi's summary of the branch being left, with optional
custom instructions. Group actions into This session and New session; user entries offer both Fork
and Clone. Carry branch summary defaults off, reveals instructions when enabled, and precedes the
same-session actions in visual/keyboard order; it applies only to those actions, not Fork/Clone.
Keep the action dock bounded and independently scrollable, and identify the conversation being left.
Honor Pi's skip-summary-prompt preference; searching and previewing never generate summaries.

Cancellation follows Pi's outcome. Ordinary summary cancellation uses native abort and preserves
the worker/extension locals when it settles. Confirmed worker retirement is the fallback for an
explicitly cancelled operation that cannot settle; never show a falsely completed destination.

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

When a worker holds a navigation lease away from the latest saved point, show a compact notice above
the transcript explaining that new messages continue from earlier history. **Restore saved position**
uses the confirmed snapshot revision to restore where the next message will continue. If
the saved point is a user or custom message, restoring it retires the idle owned worker and the next
local action opens Pi at the exact saved point. Other branch ends that Pi can only edit are still
available through **Edit from here** in History.
The notice is available with History closed. Dismissing it hides it for the current view and leaves
the continuation in place. The command palette still offers the restore action. **Clone current branch**
in the session menu copies through the displayed point without changing the source session.

Use the Host's navigation lease and durable/effective leaf pair for this presentation. A difference
caused by following an attached Pi or viewing a saved session alone does not qualify. Fit the notice
to its content and the available reading stage. Reserve only the measured clearance needed above the
transcript and its scroll targets, including when diagnostics wrap.
