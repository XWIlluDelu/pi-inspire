---
purpose: One composer owns editing, drafts, prompt artifacts, input handoff, Pending recovery, and command feedback.
covers:
  - server/{attachments,attachment-references,composer-history,runtime-composer-artifacts,runtime-pending*,project-files,image-content,assistant-text}.ts
  - shared/{contracts,pending-preview,composer-artifact-references,resource-references}.ts
  - src/{App,api,store,app-state,clipboard-files,composer-*,session-drafts,model-options}.ts*
  - src/controllers/composer-controller.ts
  - src/components/{ActivityBar,AttachmentList,Composer,ComposerInput,ImagePreview,ModelSelector,ProjectFiles,Transcript,transcript-rows,Welcome,ExportDialog}.tsx
  - src/styles/*.css
  - tests/server/{attachments,attachment-retention,composer-history*,runtime-composer-artifacts,runtime-pending*,runtime-compaction,app}.test.ts
  - tests/shared/{composer-artifact-references,pending-contracts}.test.ts
  - tests/web/{composer*,session-drafts,store-composer,transcript-inspection,welcome*,model-selector,model-store}.test.ts*
  - tests/browser/{workbench,model-selection,project-file-picker,pending-input}.spec.ts
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
`(hover: none) and (pointer: coarse)`, Return always inserts a newline, including with an attached
keyboard; only the explicit send action submits. Submission uses the visible Steer/Queue selection.

Each session retains unsent text, attachments and project references across switching. Text restores
from tab-session storage for the same Host origin; New has a separate text partition. Attachments and
project references remain memory-only. Handoff, explicit clear and deletion remove saved text;
failed/unknown-delivery recovery uses the same draft path. Denied browser storage leaves in-memory
editing and sending usable. Empty partitions are discarded; non-empty work remains until sent or
removed. `ComposerController` owns artifact partitions and delivery through `AppStore`, the sole
browser snapshot and cross-domain commit authority. Append-only transcript updates preserve the
active textarea, focus and selection.

The compact input keeps its padding, control order and icon-only send button. Controls wrap only as
needed; phone Steer/Queue buttons split their delivery row equally. At widths up to 420px, Model and
Thinking sit together with an 8px token gap on the selector row. Model shrinks without growing into
spare space; long labels truncate while Thinking keeps its full width. Stop retains its existing
filled error-color treatment and delivery-row placement. Desktop controls are unchanged.
The textarea grows with content.
Expand appears at the top right only when actual compact layout requires internal scrolling. The same
input expands within the main column, preserving text, artifacts, focus and selection. Collapse
remains available even after text becomes shorter and restores compact layout; no hidden control
reserves an overlay gutter. Wrapping, container width and visual-viewport changes update the height
budget while reserving space for controls. Expansion has 44px touch targets and takes no Escape
ownership from completion, modals or Stop.

### Retained prompt history

The active editor traverses Pi-style newest-first history from the selected branch's retained user
messages, including pre-compaction messages and reopened sessions. Trim entries, suppress only
consecutive duplicates and retain at most 100 prompts; accepted prompts join immediately. Unmodified
Up first performs ordinary wrapped-line navigation, then moves to logical-line start before recalling
older entries. Down navigates to the last visual line, recalls newer entries and finally restores the
exact pre-browse draft, selection and artifacts. Editing a recalled entry exits browsing without
changing history. Completion and IME own their keys first; history scope follows session/branch.

Text, embedded images, ordinary uploads and project files are recalled together. Artifacts address
branch-bound entry identities and image/file coordinates, not mutable context-message offsets. The
Host rehydrates image bytes, requires durable Inspire ownership for ordinary upload paths even after
restart, and revalidates regular project files within the current canonical workspace again after
worker startup immediately before delivery. Missing or changed files fail visibly and remain removable.

History pages carry exact entries under a serialized-byte bound and one content identity; assistant
appends cannot corrupt offsets. A history-relevant version invalidates payload caches independently of
compaction and assistant/tool appends. Cache reuse never supplies an old effective leaf as current
artifact authority. Evidence: [[follow-composer-editing-2026-10-02]].

## Project files and completion

The explicit picker and caret-local `@` query use bounded filesystem search. An established session
addresses its immutable workspace. New searches the typed or inherited prospective directory without
creating a session. Picker selections bind to its canonical root; changing the directory clears them,
and creation uses that root. New's inline selections use absolute canonical-workspace paths so a
later directory change cannot retarget them.

The explicit project-file picker (Composer and Welcome) keeps its compact single-line rows and
existing placement/keyboard behavior. Each result uses the shared 13px monochrome file-type icon,
filename at weight 500, and parent directory without repeating the filename; root files have no
directory caption. Literal query-term matches use weight 600 and inherited colors with no background.
Full relative paths remain in titles/accessibility labels. Long filenames elide without overflowing;
other picker surfaces and referenced-file chips are unchanged.

Both searches offer default-off Show hidden files for dot names and native hidden attributes,
independently of Git ignore. Incomplete scans are reported; Git failure does not block discovery.
Picker chips are deduplicated and removable. Search results confer no delivery authority: the Host
revalidates canonical regular files within the workspace at the prompt boundary and before delivery.
Selected paths become JSON string literals under an explicit context heading, so filename newlines
and list markers cannot manufacture instructions.

Inline `@` completion shares the picker/Files file-type icons, parent-only directory captions and
literal-term emphasis. Full relative paths remain in titles and accessible option labels; root files
omit directory captions. Its existing desktop two-column/narrow stacked layout and virtualized
candidate handling are retained. Slash command titles keep the command name in the primary color
and render native argument hints at weight 400 in the muted color; descriptions and model/thinking
argument candidates are unchanged.

`@` insertion replaces only the active token, preserving sentence position and repeated references.
Paths with spaces are quoted; unfinished and quoted queries accept spaces. Committed references stay
committed during prose and text-draft restoration, reopening search only when edited. Inline completion
adds neither chips nor a trailer and sends entered text unchanged; it does not inject file contents.

Leading `/` completion applies only while the caret remains in Pi's command token. Unfiltered commands
are grouped by source; a query ranks names globally with Pi TUI's pure `fuzzyFilter`, not descriptions
or terminal dependencies. Preserve source attribution and native ownership under [[pi-integration]].
Terminal-only options explain their limitation accessibly. Selection inserts the exact command and a
trailing space only for argument-taking commands; it never executes.

After `/model`, offer Pi provider/model identities; after `/thinking`, offer supported levels. Replace
only the argument token. Free-text native arguments get concise usage hints; extension arguments are
not inferred. Inline `@` search remains available in prompt arguments, not export destinations.

Completion reports loading, empty and failure states and rejects stale session results. Arrow,
Enter, Tab, Escape and pointer selection use combobox/listbox semantics while the multiline textbox
keeps focus, `aria-controls`, `aria-activedescendant` and autocomplete state inside its ARIA 1.1
combobox composite. Picker Home/End keep text-navigation behavior and disabled options are skipped;
each query clears obsolete results. Outside click/focus dismisses without taking destination focus;
Escape restores the trigger. An unchanged dismissed token does not reopen. The picker anchors to its
button and flips within the viewport; caret completion uses the roomier side of the active line,
clamped to the live center viewport, including New and mobile keyboards. Browser spelling/grammar
proofing is disabled for technical input.

## Attachments and image inspection

Images accept paste, drop and file selection. Staged images are separate thumbnail tiles with overlay
removal, not metadata chips. Ordinary file chips emphasize the filename, upload/error state and
removal. Full filenames, MIME/size or recalled-file provenance stay in native tooltips rather than
repeating inline; errors retain their diagnostic and removal guidance. Filenames truncate without
squeezing status/removal controls, and file chips do not stretch to adjacent image-tile height. Clipboard
`files` is the complete source when non-empty; only an empty list falls back to file-kind `items`.
Do not combine these projections or deduplicate distinct files by coincident metadata.

Activating an image opens the shared focus-contained viewer. A crisp, shadowless image sits above the
standard viewport scrim and 2px blur. Only its pixels receive an opaque neutral checkerboard, shared
by staged, conversation and file images across themes/formats. Checkerboard / White / Black controls
change inspection background without changing bytes, zoom or pan; each opening defaults to
Checkerboard without a stored preference or alpha scan. Image and controls form one content-sized
centered group: close above its right edge, selector centered below. Controls use the active theme,
remain outside the canvas, have 44px targets and fit within safe areas on narrow/landscape screens.
Activation toggles fit/2× zoom; movement crosses a threshold before zoomed panning. Only backdrop,
close or Escape dismisses. Native image dragging is disabled so inspection cannot restage an image.

Delivered user images remain inspectable after refresh. Pi JSONL owns bytes; bounded transcript data
carries MIME and stable message/part coordinates, and authenticated session/view-bound reads supply
thumbnails without embedding duplicate bytes in browser state.

### Transfer and retention

| Bound | Value |
| --- | --- |
| Attachments per message | Eight |
| Raw bytes per file / message | 16 MiB / 32 MiB |
| Raw image bytes per message | 20 MiB |
| Serialized Pi command / stdout envelope | 32 MiB / command bound plus 1 MiB |

The browser refuses excess staging before upload. Multipart storage counts streamed raw bytes in
private `0600` files and aborts excess batches. Resolution rechecks totals and encodes images
sequentially within the Base64 budget; RPC rejects excess commands before stdin. Upload observation
covers headers/body for 120 seconds plus allowance at 128 KiB/s. Transport replacement cancels
observation; withdrawing the batch's last attachment cancels it. Timeout marks remaining chips failed
with remove/re-add guidance, without resending. Late handles are reclaimed even when cancellation is
ignored. Switching sessions preserves the upload owner. Inspire never silently uploads elsewhere.

Withdrawing staging deletes its owned copy. Delivered images remain in Pi and release upload copies;
sent ordinary files and ownership metadata survive Host restart. Shutdown drains uploads/runtime work
before withdrawing staging and preserves accepted ordinary files.

Collection follows references across all entries/branches in default, configured and remembered
custom Pi storage, recoverable desktop Trash and private deletion recovery. Shared forks retain an
upload until the last reference disappears. Confirmed deletion and periodic sweeps trigger collection.
Incomplete, unreadable or changing Pi sources defer it; unrelated valid non-Pi JSONL in Trash does not
block it. Staged, in-flight, accepted-but-unpersisted and recalled resend owners stay protected.
Native `handled` input adds no future-reference hold, but persisted hook references still count.
Scanning/resend leases recognize literal paths and Inspire's exact JSON-string form. Only
ownership-recorded upload copies can be removed, never original user/project files.

Ready handles survive same-Host reconnect. Changed Host authority invalidates them in every partition,
including saved history drafts and failed deliveries; a definite expiry refusal names only affected
uploads. Invalid chips explain remove/re-add and block send. Recovery does not silently reupload or
resend acceptance-unknown input. Upload cleanup cannot revoke confirmed prompt acceptance.

## Delivery and Pending

Submission synchronously hands the exact draft/artifacts to an independent operation, including the
first Welcome message, leaving the editor ready for the next input. Delayed receipts cannot clear
newer drafts. Definitive failure or unknown acceptance restores input into an empty editor; otherwise
Restore retains it without replacing newer work. Artifacts release only on confirmed acceptance,
explicit Clear or withdrawal after restoration. Known acceptance remains non-retryable even if later
projection reconciliation conflicts; [[session-persistence]] owns the resulting writer fence.

Uploads still pending, failed chips and artifact limits block send/staging with local warning notices,
not a session-wide error banner. Late results update their original partition and visible Restore
affordance immediately; they change the global error only while that session still owns the surface.
Unchanged-draft retries after uncertain acceptance preserve the exact operation and payload under
[[session-transport]], even when the default delivery mode has since changed.

`running`, `retrying`, `queued` and `compacting` share Host/browser delivery authority. Active work
exposes equal-width Steer / Queue choices beside Stop; the selection controls placeholder and send
accessible name. Compaction accepts bounded Host-held input at Pi's actual boundary under
[[pi-integration]]. Only Running gives the whole Composer a slow theme-colored breathing halo,
including descendant focus; Retry/Compaction and reduced-motion Running use static semantic halos.
Conflict recovery remains abortable but is not active busy ownership.

The adjacent activity surface names Retry/Compaction from session state, including automatic work and
reconnect. Available attempt/reason details enrich the label; missing details never invent counters.
Ordinary, compaction and summary retry keep short status separate from wrapping reasons. Executing
and failed tools remain in chronological cards.

Pending sits at Transcript's end, immediately showing ordered Steer/Queue input. As secondary
information, the panel deliberately uses 0.75 overall opacity, a transparent background and a quiet
border at rest; hover or focus within restores full opacity, the shared surface and normal hairline.
One header contains the total and actions ordered Copy, Return, Clear. All header and item actions
use emphasized presentation: they remain visible and inherit the panel's 0.75-to-1 opacity without
additional button-level dimming. [[design-system]] owns the shared presentation model. A fully supplied
single-mode queue names its mode in that header; mixed queues use quiet group labels without group
counts or per-row S/Q badges. Bounded previews with omitted entries retain a generic header and visible
group labels, since the supplied groups cannot establish the whole queue's mode. ActivityBar keeps its
compact count. Text previews preserve beginning and end, up to three leading lines and one trailing
line within 512 characters, with explicit middle ellipsis.
Short text stays whole; omitted rows retain total and omitted counts. Known images have wrapping,
clickable thumbnails from retained handles through the attachment endpoint. Until handles arrive,
count-only rows show Image / N images; unknown empty rows imply no image. Consumed image admissions
leave the public view even if Pi retains empty captions. Display, full-copy and recovery share that
unconsumed view across runs.

- **Copy:** item copy reads complete text at the matching Host queue revision/coordinate. Copy all
  includes omitted rows, numbered with Steer before Queue and order preserved within each group.
  Neither stops or removes input. Missing/stale full content fails instead of copying a preview.
- **Return all:** dequeue unconsumed Pi and Host-held input without stopping the task. Join Steer,
  then Queue, then the latest original-session draft with blank lines. This is one editable draft;
  message boundaries/modes are not retained and resending uses the newly selected mode. A delayed
  receipt merges into its original partition, preserving newer text/artifacts and another session's
  work. Explicit Return restores focus only while its view/action/focus still owns it.
- **Stop / unclaimed Escape:** recover Pending before stopping through [[pi-integration]]. Modal,
  completion and context-hint Escape have priority. Stop blocks deliveries while in progress and
  cannot leave queued work able to resume. Recovery remains available through suspended prompt hooks,
  preflight, conflict and standalone-compaction cancellation.
- **Clear all:** confirmation discards unconsumed input without stopping Pi or changing the draft;
  X cancels. Cleared Host deliveries are definitely rejected and release staged artifacts.

Return/Stop restores original Inspire-submitted pending images, including recalled images, in order
and multiplicity beside the latest text/artifacts, including history-hidden drafts. Already consumed
images do not return; discarding releases copies. An over-limit recovered draft stays intact with a
send explanation. Expanded file/reference text remains intact. Pi's text-only dequeue and absent
item/image metadata cannot identify extension-added/replaced bytes; unresolved ownership does not
authorize guessing. Warn only with positive evidence of unrecovered image content, not for known
text-only recovery. Still Host-held artifacts are restaged once without duplicate failed-text restore.
Evidence: [[follow-pending-input-recovery-2026-10-02]].

## Command surfaces and feedback

Native routing follows [[pi-integration]]. Accepted `!`/`!!` commands join prompt history with their
original prefix, including after compaction/reopen, without starting a model turn. Typed native and
direct-shell input reject staged artifacts without discarding them. Palette-native actions reuse the same controls without borrowing the message
draft; Fork/Clone behavior follows [[session-branches]]. Graphical Export opens the same standalone
format/download dialog from title menu or palette, with no command editor or draft mutation. Failure
retains its chosen format; an extension question keeps foreground ownership without discarding it.

Resource commands use one transient `ComposerInput` preparation step with review and explicit submit.
It does not replace or consume message partitions. Initial caret follows `/command ` without resetting
later selections. Current command text determines semantics: extension handlers execute immediately;
template/skill prompts expose Steer/Queue only during applicable work. Failed preparation stays open
with its input. Extension dialogs hide/deactivate the palette but preserve preparation; completion
uses the modal's focus/stacking layer. Escape returns to search before closing. Ordinary IME,
touch-first and submit-key boundaries apply.

Command receipts describe this browser's request/results, not Pi's current run phase. Compact retains
eventual success/cancel/error; its running phase uses the state-owned activity surface, identical to
automatic compaction. Delayed HTTP receipts cannot extend/end it. Headers show command/outcome,
without local timestamps; `createdAt` remains metadata. Successful Compact retires when later agent
work or compaction starts, leaving its durable checkpoint. Export/Reload retain named receipts.
Successful Copy, argument-bearing Name, exact Model and valid Thinking use brief confirmation;
failures retain their actual diagnostic without duplicate generic notices. Ordinary controls own their
warning notices. Running receipts show command/phase without invented progress or placeholder advice.
Host adapter copy is not represented as verbatim Pi UI text; Reload explains worker-local state reset.
Composer, receipts and extension widgets share outer width with independent scrollports and visible
overlay rails. [[conversation]] owns summary cards and event-owned cancellation/failure notices.

Copy last response reads complete settled assistant text through the authenticated session/view-bound
Host endpoint without starting a worker, trimming source or using a partial/preview. Selection/branch
change invalidates the read before clipboard mutation.

The context meter remains occupancy. Its ring/percentage opens a read-only model and used-token/window
hint on hover/focus or touch tap until outside dismissal, within the viewport without focus/layout
transfer. Report Pi percentages above 100%; clamp only ring/range. Unknown post-compaction usage shows
`—`, retains capacity and explains “Updates after the next reply”, never zero. Escape closes the hint
after menus/completion/modals/IME but before Stop. Historical checkpoints show persisted tokens-before;
after-token receipt estimates stay labelled and are not fabricated after reload. Evidence:
[[follow-compaction-cancellation-2026-10-02]], [[native-command-compatibility]].

## Model controls and New

Toolbar order is model, thinking, project files and attachments, then context and send/abort.
[[design-system]] owns sizing; project identity is in the topbar under [[workbench]].

The model picker groups/searches Pi choices by provider/ID/display name, with Common first and a
bounded successful-only provider-local MRU; unavailable MRU stays saved but hidden. Only the catalog
scrolls. Viewport placement precedes opening; search receives focus and selection/dismissal restores
the trigger, including mutation failure. Escape precedes Stop. Refresh retains highlighted identity
unless a newer query/pointer/key choice intervenes. Cached choices appear immediately while the
owning worker refreshes without interruption or selection change; failure keeps cache and local
status. Changes commit selection/recency only on success; failed thinking rolls back and both warn.

New uses the same editor/artifacts, with a full-width editable directory address/browser below the
toolbar. Its filled bordered input expresses path editability and remains separate from the message.
The first-message editor receives initial autofocus. Directory Enter does not implicitly submit
creation; IME confirmation remains native. Review evidence: [[follow-frontend-refinement-2026-10-07]].
Readiness distinguishes pending/failed model resolution and in-flight creation; errors offer Retry
and Pi's `unknown/unknown` means no model. While cwd matches, the inherited worker supplies model and
resource completion; changing directory clears its commands until the new worker loads. Existing-
session built-ins appear after creation; Host Compact also works before the first message.

Files stay browser-local until Pi supplies a session identity, then use ordinary upload lifecycle.
Completion sends the first prompt only while that session remains selected; otherwise work remains
in its partition. The editor grows to bounded viewport height. New model/thinking inheritance and
workspace-default resolution follow [[model-settings]]: late source selection is inherited, later
manual effort wins, and catalog refresh alone does not reapply defaults. Non-reasoning models disable
thinking. Automatic discovery waits for a pause in directory typing; opening the picker refreshes
immediately after Host directory validation. Evidence: [[follow-model-selection-2026-10-02]] and
[[follow-native-model-workflow-2026-10-05]].

## Checks

Editor/controller tests cover session partitions, text/history restoration, completion and keyboard
ownership, artifact handoff and delayed results. Host/native tests cover upload retention, prompt
history, bounded admission and Pending recovery; browser tests cover focus, narrow layouts, image
inspection and command preparation. Protocol and worker checks belong to the linked owners above.
