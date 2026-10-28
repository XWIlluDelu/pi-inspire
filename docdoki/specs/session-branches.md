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
  - src/components/{BranchTree,EarlierBranchBanner,AppTopbar,SearchMatchText}.tsx
  - server/attachments.ts
  - shared/contracts.ts
  - src/store.ts
  - src/controllers/composer-controller.ts
  - tests/server/{runtime-branching,session-fork,session-tree,branch-bridge-extension,session-export.integration,generated-exports}.test.ts
  - tests/server/{runtime-branch-bridge,pi-branch-callback.integration}.test.ts
  - tests/web/{branch-controller,branch-tree,branch-store}.test.ts*
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

### Tree, search and content

Read bounded projections of Pi entry identities while keeping older and alternate points reachable
and searchable. Route pages retain their containing user prompt when tool/event detail crosses a
page boundary, without skipping activity. Read-only inspection never creates a navigation lease. Query, expanded nodes, selected preview,
explicit route and outline/detail positions survive tool switches and F5 as browser-tab-local
metadata scoped by session and workspace. Tree and entry content are read again under current
authority; saved navigation never includes content, loading flags or continuation authorization.

Ordinary user-input snippets use the shared user-content projection: readable file names replace
transport trailers, image-dimension notes are omitted, and image cues remain. Search snippets and
detailed reads expose retained source so path matching, Copy and editing remain possible.
History search matches the whole trimmed query as a case-insensitive literal phrase; Files instead
uses whitespace-separated terms. Match emphasis preserves text and accessible role labels. Activity
disclosures retain complete accessible names and expanded state, without counts or ordinals inferred
from a bounded page. Keep route marks/current-route metadata aligned with their entry and use shared
pane states for empty results without repeating the query in the state title.

Read complete retained entries in bounded chunks. Ordinary assistant/tool content stays rich;
native shell records show command, output, status and context inclusion as Shell activity rather
than system bodies or storage JSON. Decode Host-generated fences into separate wrapping monospaced
command/output regions with an optional truncation/full-log footer. Stdout stays literal, without
Markdown, syntax highlighting or terminal-insertion controls. The History body owns scrolling;
Shell output does not introduce a nested viewport.

Shell Copy reads the complete retained entry and removes transport fences. Once the bounded reader
is complete, separate Host full-output metadata may offer authorized file preview; keep its path
available in the tooltip and copied record. Text printed in stdout never becomes that metadata.
History text uses the same authorized file-preview actions as Transcript.

### Copy, images and read recovery

Each selected entry has one constant Copy action in its detail header, including Shell's own header.
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

Route/search pages, selected entries and images retry transient failures with bounded backoff inside
the original read promise. New queries, entries, session/view/selection or transport owners cancel
recovery. Persistent/definitive failures retain local Retry, selected entries, loaded pages and the
Back anchor. Errors wrap paths inside their content area without obscuring the preview header.
Recovery never repeats navigation, Fork, Clone or clipboard copying.

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
same-session actions in visual/keyboard order. It applies only to those actions, not Fork/Clone.
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
block copying because no source command or replacement occurs. External-owner and terminal-handoff
read-only sessions may be copied.

Pi determines ancestry, labels, metadata and the generated identity:

- Fork excludes the selected user message and returns it as the destination draft, with text and
  saved images in original order/multiplicity. Restage image bytes from the admitted projection as
  independent private attachments; original upload handles and file paths are unnecessary. Return
  handles/metadata rather than Base64. Use ordinary Composer thumbnails, preview, removal and
  explicit send, including image-only input. Message-wide limits apply at send time so users can
  trim oversized drafts; invalid, unsupported or individually oversized images reject Fork without
  silently dropping content. Failed publication/attachment and retired browser responses withdraw
  their unclaimed staged copies.
- Clone includes its endpoint, or produces native header-only JSONL for an empty path, and opens an
  empty destination Composer.

Neither action sends a model prompt or transfers the source's unsent draft/artifacts or pending input.

### Snapshot and publication

Capture a fresh conflict-free committed source prefix and retained endpoint. A bounded one-shot
process copies and verifies exactly that complete JSONL prefix in a private same-directory container,
then opens only the snapshot with installed Pi `SessionManager`. It creates no AgentSession/resource
loader and neither commands nor pauses, aborts, rebinds or writes through the source worker. Source
models, tools, extensions, queues, dialogs and work continue unchanged. The real canonical source
path supplies parent provenance; materialize header-only or otherwise deferred no-assistant output.
Appends and partial trailing writes beyond the admitted prefix never enter the copy.

Before publication, open the private projection and reserve the generated id/final path. Publish the
complete JSONL atomically without replacement, reopen under that reservation, and attach a processless
destination before normal configured warmup. Concurrent open/create/delete shares the reservation;
catalog-driven opens wait for it. Destination attachment is independent of Host selection.

The response always identifies the destination. Change automatic Host selection only if the source
is still selected and no newer selection intent arose since dispatch, including while awaiting the
source operation lane. Pre-publication failure removes staging; post-publication failure identifies
the committed destination rather than inviting blind retry.

## Browser action ownership

Tree/action responses require the original API, transport generation, selection generation/intent
and transcript view. Revisiting a session cannot revive pending Fork, Clone or Return to latest.
Preparatory navigation reads retain the original gesture's owner. Tree reads and same-session
navigation also bind the effective leaf; independent copies bind the admitted source prefix, so
ordinary source appends cannot prevent the published destination from opening.

Bootstrap or selection replacement retires pending tree/actions and their actionable presentation.
Successful view-changing actions clear their old markers. If an ordinary append changes the effective
leaf but not the view, a still-current discarded response retires only its own marker and schedules
read-only History revalidation; it cannot clear a newer request's marker.

Connection loss or projection change marks retained History stale. Fresh snapshots and healthy
reconnects renew it automatically; transient failures retry with bounded backoff while preserving
rows. Position-changing actions require a current validated tree. Only persistent/definitive read
failures expose local error/Refresh controls. Recovery never replays navigation or copy gestures.
Current-branch Clone failures use the visible notification stack even when History is closed;
node-specific actions retain their local error/retry surface.

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
disable Rename. Fork/Clone retain independent-copy admission across the title menu, palette and
current-branch action.

Graphical Export captures a private managed download and removes temporary native source files on
success or failure. Authenticated, session-owned opaque ids serve those snapshots, not caller-selected
Host paths, and later output cannot retarget them. Retain at most 16 downloads for 24 hours, remove
them on shutdown and require re-export after Host restart. Failed allocation stays retryable and
all acquired handles close. [[composer]] owns the dialog and typed receipts.

## Earlier-branch presentation

A leased earlier branch shows a persistent notice above the transcript with Return to latest and
endpoint-inclusive Clone from here, whether or not History is open. Return refreshes the runtime-owned
branch projection; Clone captures the displayed endpoint without a History refresh. Derive the notice
from the runtime's durable/effective leaf pair, never a browser-owned branch state. It clears only
after the resulting snapshot owns the durable leaf.

Fit the notice to the reading stage, including narrow centers between side panes. Keep its branch
mark aligned with the first title line when diagnostics wrap. Initial reading space and native
scroll-target insets retain their minimum spacing and expand with the measured notice so diagnostics
remain clear of content and targets stay aligned.
