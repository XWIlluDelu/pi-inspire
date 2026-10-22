---
purpose: One composer owns editing, drafts, prompt artifacts, input handoff, Pending recovery, and command feedback.
covers:
  - server/{attachments,composer-history,runtime-composer-artifacts,runtime-pending*,project-files,image-content,assistant-text}.ts
  - shared/{contracts,pending-preview,composer-artifact-references,resource-references,image-dimension-notes,attachment-context}.ts
  - src/{App,api,store,app-state,clipboard-files,keyboard-input,composer-*,session-drafts,model-options}.ts*
  - src/controllers/{composer,pending-recovery}-controller.ts
  - server/pending-operation-receipts.ts
  - tests/server/app-pending-recovery.test.ts
  - tests/integration/{pending-deferred-images,recovered-image-user-intent}.test.ts
  - src/components/{ActivityBar,AttachmentList,Composer,ComposerInput,ImagePreview,ImageLightbox,ImageGallery,ModelSelector,ProjectFiles,Transcript,transcript-rows,Welcome,ExportDialog}.tsx
  - src/{image-viewport,use-image-viewport,use-image-history}.ts
  - src/styles/*.css
  - tests/server/{attachments,attachment-file-names,attachment-retention,composer-history*,runtime-composer-artifacts,runtime-pending*,runtime-compaction,app}.test.ts
  - tests/shared/{composer-artifact-references,pending-contracts}.test.ts
  - tests/web/{composer*,session-drafts,native-commands,readonly-session,transcript-actions,welcome*,model-selector,model-store}.test.ts*
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
`(hover: none) and (pointer: coarse)`, Return always inserts a newline, including with an attached
keyboard; only the explicit send action submits. Submission uses the visible Steer/Queue selection.
Input-method-owned keydowns remain native even if `compositionend` preceded the final keydown:
`isComposing` or key code 229 prevents submission, completion/history selection and dialog actions.
The next ordinary key retains its existing behavior.

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
spare space; long labels truncate while Thinking keeps its full width. Send is the rightmost action
in both idle and busy states; Stop appears immediately to its left in visual and DOM/tab order.
The Send element stays mounted across idle/busy transitions. Stop retains its square icon, compact
geometry and filled error-color treatment, including cancel-compaction and shell Stop. Conflict
recovery keeps its warning treatment and remains the sole action when delivery is unavailable.
Send colors and delivery behavior are unchanged.
The textarea grows with content.
Expand appears at the top right only when actual compact layout requires internal scrolling. The same
input expands within the main column, preserving text, artifacts, focus and selection. Collapse
remains available even after text becomes shorter and restores compact layout; no hidden control
reserves an overlay gutter. Wrapping, container width and visual-viewport changes update the height
budget while reserving space for controls. Expansion has 44px touch targets and takes no Escape
ownership from completion, modals or Stop.

### Retained prompt history

The active editor traverses Pi-style newest-first history from the selected branch's retained user
messages, including pre-compaction messages and reopened sessions. Image-prompt recall omits Pi's
appended dimension/coordinate-mapping notes from editable text, while retaining all image artifact
coordinates and the original stored source. Mixed image/file prompts unwrap that suffix before
recovering file references, so the editable text never gains the model-facing file-context list.
The shared reading projection is specified in [[conversation]].
Trim entries, suppress only consecutive duplicates and retain at most 100 prompts; accepted prompts join immediately. Unmodified
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
artifact authority.

## Project files and completion

The explicit picker and caret-local `@` query use bounded filesystem search. An established session
addresses its immutable workspace. New searches the typed or inherited prospective directory without
creating a session. Picker selections bind to its canonical root; changing the directory clears them,
and creation uses that root. New's inline selections use absolute canonical-workspace paths so a
later directory change cannot retarget them.

The explicit project-file picker (Composer and Welcome) keeps its compact single-line rows and
existing placement/keyboard behavior. Each result uses the shared 13px monochrome file-type icon,
filename at weight 500, and parent directory without repeating the filename; root files have no
directory caption. Same-line directory captions have a secondary `@` cue; it is visual only,
not part of path values, titles, accessibility labels, or search matches. Literal query-term matches
use weight 600 and inherited colors with no background.
Full relative paths remain in titles/accessibility labels. Long filenames elide without overflowing;
other picker surfaces and referenced-file chips are unchanged. The search row owns its full-width
bottom boundary across the input and hidden-files toggle; only input focus applies the accent color.

Both searches offer default-off Show hidden files for dot names and native hidden attributes,
independently of Git ignore. Incomplete scans are reported; Git failure does not block discovery.
Picker chips are deduplicated and removable. Search results confer no delivery authority: the Host
revalidates canonical regular files within the workspace at the prompt boundary and before delivery.
Selected paths become JSON string literals under an explicit context heading, so filename newlines
and list markers cannot manufacture instructions.

Inline `@` completion shares the picker/Files file-type icons, parent-only directory captions and
literal-term emphasis. Full relative paths remain in titles and accessible option labels; root files
omit directory captions. Its existing desktop two-column/narrow stacked layout and virtualized
candidate handling are retained. A wrapping filename keeps its file-type icon centered on the first
line; same-row directory captions share that line's text baseline. Slash command titles keep the
command name in the primary color and render native argument hints at weight 400 in the muted color;
descriptions and model/thinking argument candidates are unchanged.

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
removal. Coarse-pointer removal actions have a 32px target without enlarging the text chip's padding. Full filenames, MIME/size or recalled-file provenance stay in native tooltips rather than
repeating inline; errors retain their diagnostic and removal guidance. Filenames truncate without
squeezing status/removal controls, and file chips do not stretch to adjacent image-tile height. Clipboard
`files` is the complete source when non-empty; only an empty list falls back to file-kind `items`.
Do not combine these projections or deduplicate distinct files by coincident metadata.

Sent image thumbnails stay subordinate to the message: 4:3 previews grow from 104 × 78px on narrow
screens to 160 × 120px on desktop. Staged attachment tiles are 64 × 64px with a fine pointer and
80 × 80px with a coarse pointer, keeping their preview center clear of the 32px corner removal
target. Neither preview size limits the full-image viewer.

Activating an image opens the shared focus-contained viewer. Its viewport is independent of fitted
image dimensions, so small images, panoramas and long screenshots can expand into the available
space. A crisp, shadowless image sits above the standard viewport scrim and 2px blur. Only its pixels
receive an opaque neutral checkerboard, shared across themes/formats. Checkerboard / White / Black
changes inspection background without changing bytes or view; it persists across gallery navigation
but resets on reopening, without a stored preference or alpha scan. The header identifies the image
when a name is available, shows intrinsic dimensions, and provides copy, source download and close.
Theme-aware controls remain outside the clipped gesture surface, have at least 44px targets, and
fit safe areas on narrow/landscape screens.

Initial fit never enlarges a small image. Continuous zoom reaches 100% (one CSS pixel per source
pixel, independent of device pixel ratio) and up to 800%. Plus/minus, actual-size and fit controls
are explicit. Dragging or unmodified scrolling pans; pinch and Control/Command plus scroll zoom
around the pointer or moving pinch center. Double-click/double-tap toggles fit and an anchored close-up
(at least actual size);
single clicks do not reset a view. Dragging crosses a movement threshold, never dismisses, and
suppresses native image dragging/restaging. Finger-count changes rebase the gesture; cancellation
releases it. Resize/rotation refits a fitted view or preserves manual scale and clamps position.
Images cannot move completely outside the viewport. Arrow keys pan, plus/minus zoom, 1 selects
actual size, and 0 fits.

A tray, message, history detail or document can expose a gallery in displayed order, with previous,
next, position count and Page Up/Page Down navigation. Navigation resets the selected image to fit
without opening another dialog or history entry. It uses already-owned sources, never broadens
resource authorization, and retires selection on source replacement/removal or owner teardown.
Backdrop tap, close, Escape or browser Back dismisses and restores focus to the opener. One
inspection owns one same-document history entry; normal close consumes it rather than accumulating
extra Back stops. Loading and decoding failure are explicit; a failed image disables copy/zoom but
keeps source download available. Download preserves the authorized source bytes without re-encoding
or compositing the inspection background.

Fork restores the excluded user input's text and saved images into the destination draft, using
these same staged thumbnails, preview, removal and send controls. Clone leaves the draft empty;
[[session-branches]] owns extraction, independent publication and unclaimed-copy cleanup.

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
private `0600` files and aborts excess batches. Multipart filename parameters use UTF-8 so ordinary
browser uploads retain international names. Readable sanitized names remain independent of physical
cache components, which fit 255 UTF-8 bytes and the decomposed UTF-16 filename budget and do not end
in Windows-trimmed dots/spaces. Truncation preserves complete code points and ordinary short extensions.
New versioned ownership records validate both names; legacy records keep their original naming/path
rules without renaming payloads or rewriting session references.

Resolution rechecks totals and encodes images
sequentially within the Base64 budget; RPC rejects excess commands before stdin. Upload observation
covers headers/body for 120 seconds plus allowance at 128 KiB/s. Transport replacement cancels
observation; withdrawing the batch's last attachment cancels it. Timeout marks remaining chips failed
with remove/re-add guidance, without resending. Late handles are reclaimed even when cancellation is
ignored. Switching sessions preserves the upload owner. Inspire never silently uploads elsewhere.

Withdrawing staging deletes its owned copy. Delivered images remain in Pi and release upload copies;
ordinary files become durable assets rather than reference-counted caches. They survive Host restart,
session deletion, forks, native Trash and offline backups, including native `handled` inputs whose
extension may keep a path outside Pi history. Shutdown drains uploads/runtime work, removes known
staging and preserves possible deliveries.

Version-3 ownership records begin as `unsubmitted`. Resolution atomically marks each copy as
`possible` delivery before returning it to a caller that can send it to Pi. A lost receipt or crash
therefore cannot authorize automatic deletion. Failure to record this handoff refuses dispatch and
restores the staging handles. Existing unversioned/version-2 records remain durable and recallable
without changing paths or metadata.

Periodic cleanup is limited to explicitly unsubmitted copies whose process-birth-bound owner is
confirmed retired. It re-reads the record after retirement to observe a final handoff. Live or
unverified owners, unknown metadata and possible deliveries are not deletion evidence. Only recorded
private upload copies can be removed, never original user/project files. Initial storage failures
may be retried on the same Host after repair.

There is no session/Trash reference scan, directory registration, volume continuity proof or offline
trust migration. Ordinary session reads, startup, sending and deletion do not depend on these former
maintenance writes. Delivered-file reclamation is an explicit operator choice with a warning that
all surviving references will break; see [cleanup operations](../../docs/host.md#uploaded-file-retention-and-cleanup).

Preview failure does not invalidate an otherwise current staging handle. Ready handles survive
same-Host reconnect. Changed Host authority invalidates them in every partition,
including saved history drafts and failed deliveries; a definite expiry refusal names only affected
uploads. Invalid chips explain remove/re-add and block send. Recovery does not silently reupload or
resend acceptance-unknown input. Upload cleanup cannot revoke confirmed prompt acceptance.

## Delivery and Pending

The writing surface uses a 12px radius and a quiet border. Spacing, not an internal divider rule,
separates writing/delivery from the metadata/action row. Attachments stay compact with control-radius
corners; Steer/Queue keep their dedicated row rather than joining the model toolbar. Command feedback
uses neutral surfaces and semantic status icons/text, not whole-panel status washes or competing
running glows. Failed command receipts are unframed inline feedback, with bounded wrapping and an
independent compact Dismiss action; action-rich results can still use local containers. Extension widgets retain
Pi's above/below placement, with a small identity/copy header and readable preformatted content.
Extension questions remain distinct forms with a clear source label and directly selectable options;
keyboard focus, deadlines, cancellation, and touch targets are unchanged.

Submission synchronously hands the exact draft/artifacts to an independent operation, including the
first Welcome message, leaving the editor ready for the next input. Delayed receipts cannot clear
newer drafts. Definitive failure or unknown acceptance restores input into an empty editor; otherwise
Restore retains it without replacing newer work. Its compact quiet action uses the shared neutral
unavailable state while text or artifacts occupy the editor, without shrinking its 32px target.
Artifacts release only on confirmed acceptance,
explicit Clear or withdrawal after restoration. Known acceptance remains non-retryable even if later
projection reconciliation conflicts; [[session-persistence]] owns the resulting writer fence.

Uploads still pending, failed chips and artifact limits block send/staging with local warning notices,
not a session-wide error banner. Late results update their original partition and visible Restore
affordance immediately; they change the global error only while that session still owns the surface.
Unchanged-draft retries after uncertain acceptance preserve the exact operation and payload under
[[session-transport]], even when the default delivery mode has since changed.

`running`, `retrying`, `queued` and `compacting` share Host/browser delivery authority. Active work
exposes equal-width Steer / Queue choices in their own compact mode row; the selection controls placeholder and send
accessible name. Compaction accepts bounded Host-held input at Pi's actual boundary under
[[pi-integration]]. Only Running gives the whole Composer a slow theme-colored breathing halo.
A pointer-transparent pseudo-element carries a close, low-opacity halo without a broad outer wash.
Its 3.6-second cycle animates opacity, not the Composer's geometry or shadow properties. The underlying
surface keeps its normal border and its independent focus border while typing. Reduced-motion Running
keeps the static low-intensity halo; Retry/Compaction retain their separate static semantic halos.
Conflict recovery remains abortable but is not active busy ownership.

The adjacent activity surface names Retry/Compaction from session state, including automatic work and
reconnect. Available attempt/reason details enrich the label; missing details never invent counters.
Ordinary, compaction and summary retry keep short status separate from wrapping reasons. Executing
and failed tools remain in their chronological activity entries.

Pending sits at Transcript's end, immediately showing ordered Steer/Queue input. As secondary
information, the panel deliberately uses 0.75 overall opacity, a transparent background and a quiet
border at rest; hover or focus within restores full opacity, the shared surface and normal hairline.
One header contains the total and actions ordered Copy, Return, Clear. All header and item actions
use emphasized presentation: they remain visible and inherit the panel's 0.75-to-1 opacity without
additional button-level dimming. [[design-system]] owns the shared presentation model. A fully supplied
single-mode queue names its mode in that header; mixed queues use quiet group labels without group
counts or per-row S/Q badges. Bounded previews with omitted entries retain a generic header and visible
group labels, since the supplied groups cannot establish the whole queue's mode. ActivityBar keeps its
compact text count as a native Jump to Pending button, with a neutral interaction background. Activation aligns the current queue's
start below the floating reading controls, scrolls only the transcript and focuses the Pending
region without focusing the editor. It releases latest-follow; keyboard and pointer activation
share the same action. The region adds no ordinary Tab stop and retains the existing focus-within
emphasis and idle dimming. The count disappears when the queue is empty. Text previews preserve beginning and end, up to three leading lines and one trailing
line within 512 characters, with explicit middle ellipsis.
Short text stays whole; omitted rows retain total and omitted counts. Previews use the shared
user-content projection, showing file names instead of model-facing transport instructions.
Preview length and truncation describe this readable text; Copy and Return retain the exact input.
Known images have wrapping,
clickable thumbnails from retained handles through the attachment endpoint. Until handles arrive,
count-only rows show Image / N images; unknown empty rows imply no image. Consumed image admissions
leave the public view even if Pi retains empty captions. Display, full-copy and recovery share that
unconsumed view across runs.

- **Copy:** item copy reads complete text and original images at the matching Host queue
  revision/coordinate, including image-only items, uploads held during compaction and recalled images. Copy all includes omitted rows, numbered with
  Steer before Queue and order preserved within each group. Image formats, clipboard ordering and
  plain-text alternatives follow [[design-system]]. Neither action stops/removes input, recovers
  attachment ownership, or changes the draft. The queue reports an exact all-row image total, including
  omitted rows, so gesture-bound Copy can declare formats before the full-content read; older snapshots
  without this metadata retain the prior read-first path. Missing/stale full content fails instead of
  copying a preview; queue revision changes retire delayed image reads and writes.
- **Return all:** dequeue unconsumed Pi and Host-held input without stopping the task. Join Steer,
  then Queue, then the latest original-session draft with blank lines. This is one editable draft;
  message boundaries/modes are not retained and resending uses the newly selected mode. A delayed
  receipt merges into its original partition, preserving newer text/artifacts and another session's
  work. Receipt reclamation applies each handoff once, including after a lost HTTP result or a
  reconnect with the previous observer still pending. Host-held uploads and recalled images are
  included in the receipt even when another browser performs Return or Stop. The original prompt
  observer receives those same staging handles and an image-handoff identity. Apply each handle
  once per authority/session/handoff, including after the user removes or resends it and after an
  empty draft is discarded. Later recovery handoffs may return that handle again. Either response
  order preserves subsequent user actions; preview observation does not own staging validity. If image preparation fails, Return keeps Host-held input
  queued; Stop still retires the worker rather than allowing that input to resume.
  Explicit Return restores focus only while its view/action/focus still owns it.
- **Stop / unclaimed Escape:** recover Pending before stopping through [[pi-integration]]. Modal,
  completion and context-hint Escape have priority. Stop blocks deliveries while in progress and
  cannot leave queued work able to resume. Recovery remains available through suspended prompt hooks,
  preflight, conflict and standalone-compaction cancellation. The preliminary recovery and Stop
  mutation retain the original API/transport owner; a replacement cannot inherit an old Stop.
  [[session-transport]] owns their authority-bound operation receipts.
- **Clear all:** confirmation discards unconsumed input without stopping Pi or changing the draft;
  X cancels. Cleared Host deliveries are definitely rejected and release staged artifacts.

Return/Stop restores original Inspire-submitted pending images, including recalled images, in order
and multiplicity beside the latest text/artifacts, including history-hidden drafts. Already consumed
images do not return; discarding releases copies. An over-limit recovered draft stays intact with a
send explanation. Expanded file/reference text remains intact. Pi's text-only dequeue and absent
item/image metadata cannot identify extension-added/replaced bytes; unresolved ownership does not
authorize guessing. Warn only with positive evidence of unrecovered image content, not for known
text-only recovery. Still Host-held artifacts are restaged once without duplicate failed-text restore.

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

Command receipts describe this browser's request/results, not Pi's current run phase. Compact's
running phase uses the state-owned activity surface, identical to automatic compaction. Delayed HTTP
receipts cannot extend/end it. Headers show command/outcome without local timestamps; `createdAt`
remains metadata. Successful Compact and Reload retire their dock receipts and show the returned
confirmation as an INFO notice when their session is selected. Compact's durable checkpoint remains
independent of that acknowledgment. Export retains its download/path actions; cancellation, failures
and unknown outcomes retain their attributable dock result. Successful Copy, argument-bearing Name,
exact Model and valid Thinking use the same brief confirmation. Background completion does not post
a notice over another session. Ordinary controls own their warning notices. Running receipts show
command/phase without invented progress or placeholder advice.
Host adapter copy is not represented as verbatim Pi UI text; Reload explains worker-local state reset.
Composer, receipts and extension widgets share outer width with independent scrollports and visible
overlay rails. [[conversation]] owns context-event rows and event-owned cancellation/failure notices.

Copy last response reads complete settled assistant text through the authenticated session/view-bound
Host endpoint without starting a worker, trimming source or using a partial/preview. Selection/branch
change invalidates the read before clipboard mutation.

The context ring remains an occupancy indicator. Its numeric slot reserves room for three digits
and a percent sign, keeping the ring and adjacent action positions steady as readings change from
unknown to single-, double- or triple-digit percentages. Larger native values grow without clipping.
Hover/focus reveals a non-interactive model and
used-token/window hint within the viewport; activating the control by click, touch or keyboard opens
the local Session & usage result without consuming the draft or calling a model. The command palette
and `/session` reach the same result. Repeating `/session`, bare `/name` or `/quit` replaces that
query's existing readout in place and renews its reading dwell; `/session` reads the current local
snapshot synchronously. Runtime progress and prompt handoff do not interrupt a requested readout.
Leaving the selected session discards its query readouts, not operational receipts; reopening
therefore does not resurrect old usage snapshots. Refresh clears this browser-local feedback.
Reading durations, interaction pause and fade behavior follow [[design-system]].
Report Pi percentages above 100%; clamp only ring/range.
Unknown post-compaction usage shows
`—`, retains capacity and explains “Updates after the next reply”, never zero. Escape closes the hint
after menus/completion/modals/IME but before Stop. Historical checkpoints show persisted tokens-before;
after-token receipt estimates stay labelled and are not fabricated after reload.

## Model controls and New

Toolbar order is model, thinking, project files and attachments, then context, optional Stop and
rightmost Send (with conflict recovery following the exception above).
[[design-system]] owns sizing; project identity is in the topbar under [[workbench]].

Read-only history, including sessions handed to the terminal, retains a static readout of the viewed
session's selected provider/model identity and thinking effort above its read-only notice, sharing
a left edge and the normal toolbar's Model/Thinking terminology. The readout and notice form a
content-width group centered in the composer dock, with left-aligned text inside. The group stays
within the normal composer width and available viewport space, wrapping on narrow screens without
adding a card or changing the dock's vertical spacing. It uses the session snapshot, not
Host defaults or physical response identity. An unknown model stays unavailable rather than borrowing
a catalog choice. These readouts neither expose selection controls nor initiate discovery, writes
or ownership acquisition.

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
creation; IME confirmation remains native.
A missing typed directory offers one contextual **Create folder and start** action, without another
confirmation. Only that action authorizes recursive directory creation; Send, Enter, browsing and
model/file observations do not create directories. A file or inaccessible path is not offered as
creatable. The action preserves the exact first message, local artifacts and explicit/inherited
model and thinking choices. When a missing directory prevents a default preview, Pi resolves its
normal defaults after creation in that directory, without substituting another execution cwd.
Changing the path immediately retires the old action and late observations cannot restore it.
Failure preserves staged work. Opening retained history never creates its missing directory.

Readiness distinguishes pending/failed model resolution and in-flight creation; errors offer Retry
and Pi's `unknown/unknown` means no model. While cwd matches and the source workspace is available,
the inherited worker supplies model and resource completion; changing directory clears its commands
until the new worker loads. Read-only sources retain known choices, but New queries the prospective
directory rather than starting source discovery. Unresolved source selection keeps its loading/error
feedback and Retry alongside the missing-folder action. Existing-
session built-ins appear after creation; Host Compact also works before the first message.

Files stay browser-local until Pi supplies a session identity, then use ordinary upload lifecycle.
Completion sends the first prompt only while that session remains selected; otherwise work remains
in its partition. The editor grows to bounded viewport height. New model/thinking inheritance and
workspace-default resolution follow [[model-settings]]: late source selection is inherited, later
manual effort wins, and catalog refresh alone does not reapply defaults. Non-reasoning models disable
thinking. Automatic discovery waits for a pause in directory typing; opening the picker refreshes
immediately after Host directory validation.

## Checks

Editor/controller tests cover session partitions, text/history restoration, completion and keyboard
ownership, artifact handoff and delayed results. Host/native tests cover upload retention, prompt
history, bounded admission and Pending recovery; browser tests cover focus, narrow layouts, image
inspection and command preparation. Protocol and worker checks belong to the linked owners above.
