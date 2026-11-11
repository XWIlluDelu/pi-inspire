---
purpose: One composer owns editing, drafts, prompt artifacts, input handoff, Pending recovery, and command feedback.
covers:
  - server/{attachments,composer-history,runtime-composer-artifacts,runtime-pending*,project-files,image-content,assistant-text}.ts
  - shared/{contracts,pending-preview,composer-artifact-references,resource-references,image-dimension-notes,image-types,attachment-context}.ts
  - src/{App,api,store,app-state,clipboard-files,keyboard-input,composer-*,session-drafts,model-options}.ts*
  - src/controllers/{composer,pending-recovery}-controller.ts
  - server/pending-operation-receipts.ts
  - tests/server/app-pending-recovery.test.ts
  - tests/integration/{pending-deferred-images,recovered-image-user-intent}.test.ts
  - src/components/{ActivityBar,AttachmentList,Composer,ComposerInput,ImagePreview,ImageLightbox,ImageGallery,ModelSelector,ProjectFiles,Transcript,transcript-rows,Welcome,DirectoryPicker,ExportDialog}.tsx
  - src/{image-viewport,use-image-viewport,use-image-history}.ts
  - src/styles/*.css
  - tests/server/{attachments,attachment-file-names,attachment-retention,composer-history*,runtime-composer-artifacts,runtime-pending*,runtime-compaction,app}.test.ts
  - tests/shared/{composer-artifact-references,pending-contracts}.test.ts
  - tests/web/{composer*,session-drafts,native-commands,readonly-session,transcript-actions,welcome*,directory-picker,project-file-picker,model-selector,model-store}.test.ts*
  - tests/web/{image-viewport,image-gallery,attachments}.test.ts*
  - tests/browser/{composer,file-attachments,usage-facts,model-selection,project-file-picker,pending-input,image-preview,image-interactions}.spec.ts
---

# Conversation composer

## Goal

Support Pi's ordinary prompt, steering, follow-up, resource-command and direct-shell workflows in one
editor while preserving unsent work and making delivery outcomes explicit.

## Contract ownership

- [[pi-integration]] owns native command dispatch, shell execution, compaction cancellation and RPC.
- [[session-transport]] owns prompt identities, HTTP observation and stale-response fences.
- [[session-branches]] owns Fork/Clone and export content; [[session-persistence]] owns worker admission.
- [[model-settings]] owns model identity, saved defaults, common scope and trust-aware discovery.
- [[conversation]] owns durable transcript content; [[resource-preview]] owns file readers.

## Editing and drafts

Desktop submit uses a global Enter or Ctrl/Command+Enter preference. Shift+Enter, Alt+Enter, IME
composition and the unselected chord remain multiline input. In touch-first mode, defined by
`(hover: none) and (pointer: coarse)`, Return always inserts a newline, even with an attached
keyboard; only the explicit send action submits. Submission uses the visible Steer/Queue selection.

Input-method-owned keydowns stay native even if `compositionend` preceded the final keydown:
`isComposing` or key code 229 prevents submission, completion/history selection and dialog actions.
The next ordinary key keeps its existing behavior.

Each session keeps its unsent text, attachments and project references across switching. Text
restores from tab-session storage for the same Host origin; New has a separate text partition.
Attachments and project references are memory-only. Handoff, explicit clear and deletion remove
saved text; failed/unknown-delivery recovery uses the same draft path. If browser storage is denied,
in-memory editing and sending still work. Empty partitions are discarded; non-empty work remains
until sent or removed. Draft partitions, artifact handoff and snapshot commits share one browser
authority. Append-only transcript updates preserve the active textarea, focus and selection.

Send remains mounted across idle/busy transitions. Conflict recovery is the sole action when
delivery is unavailable.

The textarea grows with content and follows live typography changes. Empty and fitting input has
no vertical scrollbar. When the dock compresses the editor, the textarea scrolls if its content
exceeds the space it actually received. Fractional line heights must not create spurious overflow.
Expand appears with the existing toolbar actions when the compact input scrolls and the reading
stage leaves room to grow. It expands the same input, preserving text, artifacts, focus and
selection. Collapse stays available after the text becomes shorter and restores the compact
layout. The action uses the surrounding controls' sizing and leaves the writing width unchanged.
Wrapping, container width and visual-viewport changes update the height budget, which reserves
space for controls. Expand and Collapse take no Escape ownership from completion, modals or Stop.

### Retained prompt history

The active editor traverses Pi-style newest-first history from the selected branch's retained user
messages, including pre-compaction messages and reopened sessions. The shared reading projection is
specified in [[conversation]].

- Image-prompt recall omits Pi's appended dimension/coordinate-mapping notes from editable text but
  keeps all image artifact coordinates and the original stored source. Mixed image/file prompts
  unwrap that suffix before recovering file references, so the editable text never gains the
  model-facing file-context list.
- Entries are trimmed, only consecutive duplicates are suppressed, and at most 100 prompts are
  kept. Accepted prompts join immediately.
- Unmodified Up first performs ordinary wrapped-line navigation, then moves to the logical-line start,
  then recalls older entries. Down moves to the last visual line, recalls newer entries and finally
  restores the exact pre-browse draft, selection and artifacts. Editing a recalled entry exits
  browsing without changing history. Completion and IME own their keys first. History scope follows
  session/branch.

Text, embedded images, ordinary uploads and project files are recalled together. Artifacts address
branch-bound entry identities and image/file coordinates, not mutable context-message offsets. The
Host rehydrates image bytes and requires durable Inspire ownership for ordinary upload paths, even
after restart. It revalidates regular project files within the current canonical workspace after
worker startup, immediately before delivery. Missing or changed files fail visibly and remain
removable.

History pages carry exact entries under a serialized-byte bound and one content identity; assistant
appends cannot corrupt offsets. A history-relevant version invalidates payload caches independently
of compaction and assistant/tool appends. Cache reuse never supplies an old effective leaf as current
artifact authority.

## Project files and completion

The explicit picker and caret-local `@` query use bounded filesystem search. An established session
addresses its immutable workspace. New searches the typed or inherited prospective directory without
creating a session. Picker selections bind to its canonical root; changing the directory clears them,
and creation uses that root. New's inline selections use absolute canonical-workspace paths so a
later directory change cannot retarget them.

The explicit picker recovers transient search failures with bounded backoff in its current workspace,
query and visibility scope; dismissal or transport replacement retires old work. Recovery only reads
candidates and never adds a reference. Persistent failures keep local feedback.

The explicit picker in Composer and Welcome uses compact single-line rows with weight-500 filenames
and parent-directory labels under [[design-system]]. A secondary `@` cue precedes same-line directory
captions; it is visual only and excluded from paths, titles, accessible names and matching. Long
filenames elide without overflowing. The search row stays on the edge nearest the toolbar trigger
as the results change. Its boundary against the results spans the input and hidden-files toggle
and uses the accent color only while the input is focused.

Both searches offer default-off Show hidden files for dot names and native hidden attributes,
independently of Git ignore. New keeps this filter choice across directory edits while clearing
directory-bound file selections. Incomplete scans are reported; Git failure does not block discovery.
Picker chips are deduplicated and removable. Search results confer no delivery authority: the Host
revalidates canonical regular files within the workspace at the prompt boundary and before delivery.
Selected paths become JSON string literals under an explicit context heading, so filename newlines
and list markers cannot manufacture instructions.

Inline `@` completion uses the same file labels, with a desktop two-column and narrow stacked
layout and a virtualized candidate list. A wrapping filename keeps its icon centered on the first
line; same-row directory captions share that line's baseline. Slash command titles use primary ink
for the command name and muted, weight-400 text for native argument hints.

`@` insertion replaces only the active token, preserving sentence position and repeated references.
Paths with spaces are quoted; unfinished and quoted queries accept spaces. Committed references stay
committed during prose and text-draft restoration and reopen search only when edited. Inline
completion adds no chips or trailer, injects no file contents, and sends the entered text unchanged.

Leading `/` completion applies only while the caret is in Pi's command token. Unfiltered commands are
grouped by source; a query ranks names globally with Pi TUI's pure `fuzzyFilter`, ignoring
descriptions and terminal dependencies. Source attribution and native ownership follow
[[pi-integration]]. Terminal-only options explain their limitation accessibly. Selection inserts the
exact command, plus a trailing space only for argument-taking commands; it never executes.

After `/model`, offer Pi provider/model identities; after `/thinking`, offer supported levels.
Replace only the argument token. Free-text native arguments get concise usage hints; extension
arguments are not inferred. Inline `@` search is available in prompt arguments, not export
destinations.

Completion reports loading, empty and failure states and rejects stale session results. Arrow,
Enter, Tab, Escape and pointer selection use combobox/listbox semantics while the multiline textbox
keeps focus, `aria-controls`, `aria-activedescendant` and autocomplete state inside its ARIA 1.1
combobox composite. Picker Home/End keep text-navigation behavior and disabled options are skipped;
each query clears obsolete results. Outside click/focus dismisses without taking destination focus;
Escape restores the trigger. An unchanged dismissed token does not reopen. The picker anchors to its
button and flips within the viewport. Caret completion uses the roomier side of the active line,
clamped to the live center viewport, including in New and with mobile keyboards. Browser
spelling/grammar proofing is disabled for technical input.

## Attachments

Images accept paste, drop and file selection. Staged images are separate thumbnail tiles with overlay
removal, not metadata chips. Attachment and project-reference rows follow the Composer content
anchor in [[design-system]].

Ordinary file chips emphasize the filename, upload/error state and removal. Coarse-pointer removal
actions have a 32px target without enlarging the chip's text padding. Full filenames, MIME/size and
recalled-file provenance appear in native tooltips, not inline; errors keep their diagnostic and
removal guidance. Filenames truncate without squeezing status/removal controls, and file chips do not
stretch to adjacent image-tile height.

Clipboard `files` is the complete source when non-empty; only an empty list falls back to file-kind
`items`. Do not combine these projections or deduplicate distinct files by coincident metadata.

Preview capability does not determine delivery kind. Browser-previewable image files such as BMP
and SVG keep their local thumbnail but travel as ordinary files. Browser selection and Host
validation share the Pi prompt-image MIME classification (PNG, JPEG, GIF, WebP); only those images
consume the prompt-image budget. All attachments count toward the file/count/total budgets.

Sent image thumbnails stay subordinate to the message: 4:3 previews grow from 104 × 78px on narrow
screens to 160 × 120px on desktop. Staged attachment tiles are 64 × 64px with a fine pointer and
80 × 80px with a coarse pointer, keeping their preview center clear of the 32px corner removal
target. Neither preview size limits the full-image viewer.

Fork restores the excluded user input's text and saved images into the destination draft, using
the same staged thumbnails, preview, removal and send controls. Clone leaves the draft empty;
[[session-branches]] owns extraction, independent publication and unclaimed-copy cleanup.

Delivered user images remain inspectable after refresh. Pi JSONL owns bytes; bounded transcript data
carries MIME and stable message/part coordinates, and authenticated session/view-bound reads supply
thumbnails without duplicating bytes in browser state.

### Image viewer

Message, attachment, History and document images open one shared viewer.

Activating an image opens the shared focus-contained viewer. Its viewport is independent of fitted
image dimensions, so small images, panoramas and long screenshots can expand into the available
space. A crisp, shadowless image sits above the standard viewport scrim and 2px blur. Only its pixels
receive an opaque neutral checkerboard, shared across themes/formats. Checkerboard / White / Black
changes the inspection background without changing bytes or view; the choice persists across gallery
navigation and resets on reopening, with no stored preference or alpha scan. The header identifies
the image when a name is available, shows intrinsic dimensions, and provides copy, source download
and close. Theme-aware controls stay outside the clipped gesture surface, have at least 44px targets,
and fit safe areas on narrow/landscape screens.

Initial fit never enlarges a small image. Continuous zoom reaches 100% (one CSS pixel per source
pixel, independent of device pixel ratio) and goes up to 800%. Plus/minus, actual-size and fit
controls are explicit.

- Dragging or unmodified scrolling pans; pinch and Control/Command plus scroll zoom around the
  pointer or moving pinch center.
- Double-click/double-tap toggles between fit and an anchored close-up (at least actual size);
  single clicks do not reset a view.
- Dragging crosses a movement threshold, never dismisses, and suppresses native image
  dragging/restaging. Finger-count changes rebase the gesture; cancellation releases it.
- Resize/rotation refits a fitted view, or preserves manual scale and clamps position. Images
  cannot move completely outside the viewport.
- Arrow keys pan, plus/minus zoom, 1 selects actual size, and 0 fits.

A tray, message, history detail or document can expose a gallery in displayed order, with previous,
next, position count and Page Up/Page Down navigation. Navigation resets the selected image to fit
without opening another dialog or history entry. It uses already-owned sources, never broadens
resource authorization, and retires selection on source replacement/removal or owner teardown.
Backdrop tap, close, Escape or browser Back dismisses and restores focus to the opener. One
inspection owns one same-document history entry; normal close consumes it instead of accumulating
Back stops. Loading and decoding failure are explicit; a failed image disables copy/zoom but keeps
source download. Download preserves the authorized source bytes without re-encoding or compositing
the inspection background.

### Transfer and retention

| Bound | Value |
| --- | --- |
| Attachments per message | Eight |
| Raw bytes per file / message | 16 MiB / 32 MiB |
| Raw image bytes per message | 20 MiB |
| Serialized Pi command / stdout envelope | 32 MiB / command bound plus 1 MiB |

The browser refuses excess staging before upload. Multipart storage counts streamed raw bytes in
private `0600` files and aborts excess batches. Multipart filename parameters use UTF-8 so ordinary
browser uploads keep international names.

Readable sanitized names are independent of physical cache components. Physical components fit 255
UTF-8 bytes and the decomposed UTF-16 filename budget and do not end in Windows-trimmed dots/spaces;
truncation preserves complete code points and ordinary short extensions. Transcript pages and live
user messages obtain readable upload names from Host ownership metadata; physical paths remain
unchanged in Pi input and Copy. Names share the transcript item/page bounds. New versioned ownership
records validate both names; legacy records keep their original naming/path rules without renaming
payloads or rewriting session references.

Resolution rechecks totals and encodes images sequentially within the Base64 budget; RPC rejects
excess commands before stdin. Upload observation covers headers/body for 120 seconds plus an
allowance at 128 KiB/s. Transport replacement cancels observation, as does withdrawing the batch's
last attachment.

The browser retains each original `File` while its unsent staging exists. Transient upload failures
keep the chip pending and recover with bounded backoff; persistent failures offer local retry
without removal or file reselection. Late handles are reclaimed even when cancellation is ignored.
Removing staging or its partition retires its retry and releases the retained bytes. Switching
sessions preserves the upload owner. Recovery stays on the configured connection and never silently
switches destinations.

Withdrawing staging deletes its owned copy. Delivered images remain in Pi and release upload copies.
Ordinary files become durable assets, not reference-counted caches. They survive Host restart,
session deletion, forks, native Trash and offline backups, including native `handled` inputs whose
extension may keep a path outside Pi history. Shutdown drains uploads/runtime work, removes known
staging and preserves possible deliveries.

Version-3 ownership records begin as `unsubmitted`. Resolution atomically marks each copy as
`possible` delivery before returning it to a caller that can send it to Pi, so a lost receipt or
crash cannot authorize automatic deletion. Failure to record this handoff refuses dispatch and
restores the staging handles. Existing unversioned/version-2 records remain durable and recallable
without changing paths or metadata.

Periodic cleanup is limited to explicitly unsubmitted copies whose process-birth-bound owner is
confirmed retired. It re-reads the record after retirement to observe a final handoff. Live or
unverified owners, unknown metadata and possible deliveries are not deletion evidence. Only recorded
private upload copies can be removed, never original user/project files. Initial storage failures
may be retried on the same Host after repair.

Delivered-file reclamation requires an explicit operator action that warns all surviving references
will break. Ordinary startup, session reads, sending and deletion do not depend on reference scans
or retention-maintenance writes. See [cleanup operations](../../docs/host.md#uploaded-file-retention-and-cleanup).

Preview failure does not invalidate an otherwise current staging handle. Ready handles survive
same-Host reconnect. Changed Host authority invalidates old handles in every partition, including
saved history drafts and failed deliveries. Unsent browser-held bytes are staged again after the
new authority is confirmed; a definite expiry refusal restages only affected files. A restored
attachment does not resubmit its message. Artifacts without retained bytes explain when reselection
is necessary. Unusable attachments block send. Once an attachment enters a prompt whose acceptance
is unknown, its original operation and handles remain fenced: neither its bytes nor the prompt enter
automatic upload recovery. Upload cleanup cannot revoke confirmed prompt acceptance.

## Delivery and Pending

[[design-system]] owns Composer geometry (input, delivery row and toolbar), state halos and
command-feedback presentation. Extension
widgets keep Pi's above/below-editor placement; questions remain separately attributed forms with
their own keyboard focus, deadlines and cancellation under [[pi-integration]].

Submission, including the first Welcome message, synchronously hands the exact draft/artifacts to
an independent operation and leaves the editor ready for the next input. Delayed receipts cannot
clear newer drafts. On definitive failure or unknown acceptance, input is restored into an empty
editor; otherwise Restore offers it without replacing newer work. While text or artifacts occupy the
editor, Restore's compact quiet action uses the shared neutral unavailable state and keeps its 32px
target. Artifacts are released only on confirmed acceptance, explicit Clear, or withdrawal after
restoration. Known acceptance remains non-retryable even if later projection reconciliation
conflicts; [[session-persistence]] owns the resulting writer fence.

Pending uploads, failed chips and artifact limits block send or staging with local warnings. Late
results update their session's draft and Restore affordance. Error notices require that session to
own the visible surface. [[session-transport]] defines receipt proof and retry identity.

`running`, `retrying`, `queued` and `compacting` share Host/browser delivery authority. Active work
exposes Steer / Queue; the selected mode sets the placeholder and Send's accessible name. Compaction
accepts bounded Host-held input at Pi's actual boundary under [[pi-integration]]. Conflict recovery
remains abortable but is not active busy ownership.

The adjacent activity surface names Retry/Compaction from session state, including automatic work and
reconnect. Available attempt/reason details enrich the label; missing details never invent counters.
Ordinary, compaction and summary retry keep short status separate from wrapping reasons. Executing
and failed tools remain in their chronological activity entries.

Pending sits at Transcript's end and immediately shows ordered Steer/Queue input. Its header contains
the total and the actions Copy, Return, Clear, in that order; panel emphasis and action visibility
follow [[design-system]]. A fully supplied single-mode queue names its mode in the header. Mixed
queues use quiet group labels without group counts or per-row S/Q badges. Bounded previews with
omitted entries keep a generic header and visible group labels, because they cannot establish the
whole queue's mode.

The activity surface's compact count is a native Jump to Pending button with neutral interaction
feedback; it disappears when the queue is empty. Pointer and keyboard activation align the queue's
start below floating reading controls, scroll only Transcript and focus the Pending region, not the
editor. Latest-follow stays active only when the destination is at the latest boundary. The region
adds no ordinary Tab stop.

Text previews keep up to three leading lines and one trailing line within 512 characters, separated
by an explicit middle ellipsis. Short text stays whole; omitted rows keep total and omitted counts.
Previews use the shared user-content projection, showing file names instead of model-facing
transport instructions. Preview length and truncation describe this readable text; Copy and Return
use the exact input. Known images have wrapping, clickable thumbnails from retained handles through
the attachment endpoint. Until handles arrive, count-only rows show Image / N images; unknown empty
rows imply no image. Consumed image admissions leave the public view even if Pi retains empty
captions. The Host combines complete Pi queue observations with Host-held input for display, copy
and recovery. An incomplete event leaves the last preview visible, and exact copy reports that
full content is unavailable.

- **Copy:** item copy reads complete text and original images at the matching Host queue
  revision/coordinate, including image-only items, uploads held during compaction and recalled
  images. Copy all includes omitted rows, numbered with Steer before Queue and order preserved within
  each group. Image formats, clipboard ordering and plain-text alternatives follow [[design-system]].
  Neither action stops/removes input, recovers attachment ownership, or changes the draft. The queue
  reports an all-row image total, including omitted rows, so gesture-bound Copy can declare formats
  before the full-content read. An unavailable deferred upload leaves that total unknown and Copy
  reads full content first. Missing or stale full content fails instead of copying a preview.
  Queue revision changes retire delayed image reads and writes.
- **Return all:** dequeue unconsumed Pi and Host-held input without stopping the task. Join Steer,
  then Queue, then the latest original-session draft with blank lines into one editable draft;
  message boundaries/modes are not kept, and resending uses the newly selected mode. A delayed
  receipt merges into its original partition, preserving newer text/artifacts and another session's
  work. Receipt reclamation applies each handoff once, including after a lost HTTP result or a
  reconnect with the previous observer still pending. Host-held uploads and recalled images are
  included in the receipt even when another browser performs Return or Stop. The original prompt
  observer receives those same staging handles and an image-handoff identity. Apply each handle
  once per authority/session/handoff, including after the user removes or resends it and after an
  empty draft is discarded; later recovery handoffs may return that handle again. Either response
  order preserves subsequent user actions; preview observation does not own staging validity. If
  image preparation fails, Return keeps Host-held input queued; Stop still retires the worker so
  that input cannot resume. Explicit Return restores focus only while its view/action/focus still
  owns it.
- **Stop / unclaimed Escape:** recover Pending before stopping through [[pi-integration]]. Modal,
  completion and context-hint Escape have priority. Stop blocks deliveries while in progress and
  cannot leave queued work able to resume. Recovery remains available through suspended prompt hooks,
  preflight, conflict and standalone-compaction cancellation. The preliminary recovery and Stop
  mutation keep the original API/transport owner; a replacement cannot inherit an old Stop.
  [[session-transport]] owns their authority-bound operation receipts.
- **Clear all:** confirmation discards unconsumed input without stopping Pi or changing the draft;
  X cancels. Cleared Host deliveries are definitely rejected and release staged artifacts.

Return/Stop restores original Inspire-submitted pending images, including recalled images, in order
and multiplicity beside the latest text/artifacts, including history-hidden drafts. Already consumed
images do not return; discarding releases copies. An over-limit recovered draft stays intact with a
send explanation. Expanded file/reference text stays intact. Pi's text-only dequeue and absent
item/image metadata cannot identify extension-added/replaced bytes, and unresolved ownership does
not authorize guessing. Warn only on positive evidence of unrecovered image content, not for known
text-only recovery. Still-Host-held artifacts are restaged once without a duplicate failed-text
restore.

## Command surfaces and feedback

Native routing follows [[pi-integration]]. Accepted `!`/`!!` commands join prompt history with their
original prefix, including after compaction/reopen, without starting a model turn. Typed native and
direct-shell input reject staged artifacts without discarding them. Palette-native actions reuse the
same controls without borrowing the message draft; Fork/Clone behavior follows [[session-branches]].

Graphical Export opens the same standalone format/download dialog from the title menu or palette,
with no command editor or draft mutation. Failure keeps the chosen format; an extension question
takes foreground ownership without discarding it. Pending exports belong to application state, not
the dialog: Close, Escape and the backdrop stay available without cancelling the operation.
Reopening observes the same task and prevents duplicate submission. Completion downloads the file
and reports the result even while the dialog is closed. Replacing the Host connection retires the
old task's UI ownership.

Resource commands use one transient preparation editor with review and explicit submit. It does not
replace or consume message partitions. The initial caret follows `/command ` without resetting later
selections. Current command text determines semantics: extension handlers execute immediately;
template/skill prompts expose Steer/Queue only during applicable work. Failed preparation stays open
with its input. Extension dialogs hide/deactivate the palette but preserve preparation; completion
uses the modal's focus/stacking layer. Escape returns to search before closing. Ordinary IME,
touch-first and submit-key boundaries apply.

Command receipts describe this browser's request/results, not Pi's current run phase.

- Compact's running phase uses the state-owned activity surface, identical to automatic compaction;
  delayed HTTP receipts cannot extend or end it.
- Headers show command/outcome without local timestamps; `createdAt` remains metadata.
- Successful Compact and Reload retire their dock receipts and show the returned confirmation as an
  INFO notice when their session is selected. Compact's durable checkpoint is independent of that
  acknowledgment. Successful Copy, argument-bearing Name, exact Model and valid Thinking use the same
  brief confirmation. Background completion does not post a notice over another session.
- Export keeps its download/path actions; cancellation, failures and unknown outcomes keep their
  attributable dock result.
- Ordinary controls own their warning notices.
- Running receipts show command/phase without invented progress or placeholder advice.
- Host adapter copy is not presented as verbatim Pi UI text; Reload explains worker-local state
  reset.

Composer, receipts and extension widgets share outer width with independent scrollports and visible
overlay rails. [[conversation]] owns context-event rows and event-owned cancellation/failure notices.

Copy last response reads complete settled assistant text through the authenticated
session/view-bound Host endpoint without starting a worker, trimming source or using a
partial/preview. Selection/branch change invalidates the read before clipboard mutation.

## Context and usage

The context ring is an occupancy indicator. Its numeric slot reserves room for three digits and a
percent sign, so the ring and adjacent actions stay put as readings change from unknown to single-,
double- or triple-digit percentages; larger native values grow without clipping. Pi percentages
above 100% are reported as-is; only the ring/range is clamped. Unknown post-compaction usage shows
`—`, keeps capacity and explains “Updates after the next reply”, never zero. Historical checkpoints
show persisted tokens-before; after-token receipt estimates stay labelled and are not fabricated
after reload.

Hover/focus reveals a non-interactive model and used-token/window hint within the viewport. Escape
closes the hint after menus/completion/modals/IME but before Stop. Activating the control by click,
touch or keyboard opens the local Session & usage result without consuming the draft or calling a
model; the command palette and `/session` reach the same result. Repeating `/session`, bare `/name`
or `/quit` replaces that query's existing readout in place and renews its reading dwell; `/session`
reads the current local snapshot synchronously. Runtime progress and prompt handoff do not interrupt
a requested readout. Leaving the selected session discards its query readouts but not operational
receipts, so reopening does not resurrect old usage snapshots. Refresh clears this browser-local
feedback. Reading durations, interaction pause and fade behavior follow [[design-system]].

## Model controls and New

[[design-system]] owns toolbar order and picker geometry; [[workspace-layout]] owns project identity
in the topbar.

Read-only history, including a session another Pi is running, shows a static readout of the viewed
session's selected provider/model identity and thinking effort above its read-only notice. For a
session another Pi is running, the notice states that its progress shows here and offers
**Take over**; a failed takeover reports its error beside the action. The
readout shares the notice's left edge and the normal toolbar's Model/Thinking terminology. Readout
and notice form a content-width group centered in the composer dock, with left-aligned text. The
group stays within the normal composer width and available viewport space and wraps on narrow
screens, without adding a card or changing the dock's vertical spacing. The Take over button is
centered below the text group; notice and error text keep the group's left alignment. It uses the
session snapshot, not Host defaults or physical response identity. An unknown model stays unavailable
instead of borrowing a catalog choice. The readout exposes no selection controls and initiates no
discovery, writes or ownership acquisition.

The model picker groups/searches Pi choices by provider/ID/display name, with Common first and a
bounded successful-only provider-local MRU; unavailable MRU entries stay saved but hidden.

- Thinking labels and option generation are shared by Welcome, the active composer, read-only
  settings and model defaults; only display labels are capitalized, not native values. Welcome and
  the active composer also share the selector's sizing, capability filter and display logic.
- Configurable extension controls compose with the selector before and after creation;
  [[tool-presentations]] defines local preselection and confirmed application before first input.
- Current-session selectors, argument completion, commands and keyboard cycling resolve model
  capabilities from the matching catalog identity, falling back to the current runtime model when no
  catalog entry exists. Refresh does not change the selected identity or effort.
- Bare `/model` opens the same picker even with an empty catalog, keeping refresh and Manage models
  as recovery/configuration entry points. Explicit model arguments still validate against the
  available choices.
- Only the catalog scrolls. Viewport placement precedes opening; search receives focus, and
  selection/dismissal restores the trigger, including on mutation failure. Escape precedes Stop.
- Refresh keeps the highlighted identity unless a newer query/pointer/key choice intervenes. Cached
  choices appear immediately while the owning worker refreshes, without interruption or selection
  change; failure keeps the cache and shows local status.
- Changes commit selection/recency only on success; failed thinking rolls back, and both failures
  warn.

New shares the editor, attachment controls and project-file picker with the session composer. The
first-message editor receives autofocus. The editable project path and its browse control sit above
it. Enter in the path field does not submit a session, and IME confirmation stays native.
[[workbench]] owns directory browsing and [[session-continuity]] owns explicit folder creation.
**Create folder and start** needs no second confirmation. Changing the path retires the action for
the old path. Creation preserves the staged input and explicit or inherited model and thinking
choices. Pi resolves any untouched defaults in the created directory.

[[model-settings]] owns readiness, inherited selection and workspace defaults. Prospective metadata
uses Pi's public resource registries and trust settings. Its commands, prompt templates and skills
feed both completion and extension controls. A fresh directory-scoped read replaces inherited
commands, including removals. A read-only source keeps known choices. If the source changes owner
or becomes unavailable, New resolves remaining choices from the prospective directory. The
missing-folder action keeps its loading feedback while these choices are unresolved and offers
Retry after persistent failure. Existing session commands appear after creation; Host Compact
is also available before the first message. Automatic discovery waits for a pause in typing;
opening the model picker refreshes after Host directory validation.

Local files stay in the browser until Pi assigns a session identity. They then use normal uploads.
The first prompt sends only while the created session remains selected; otherwise its draft and
attachments stay with that session.

## Checks

Editor/controller tests cover session partitions, text/history restoration, completion and keyboard
ownership, artifact handoff and delayed results. Host/native tests cover upload retention, prompt
history, bounded admission and Pending recovery; browser tests cover focus, narrow layouts, image
inspection and command preparation. Protocol and worker checks belong to the linked owners above.
