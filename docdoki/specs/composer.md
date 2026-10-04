---
purpose: One browser composer submits ordinary prompts, project context, images, files, steering messages, and follow-ups without exposing local privileges.
covers:
  - package.json
  - vite.config.ts
  - server/app.ts
  - server/attachments.ts
  - server/assistant-text.ts
  - server/runtime-reads.ts
  - server/image-content.ts
  - server/composer-history.ts
  - server/resources.ts
  - server/model-catalog.ts
  - server/project-files.ts
  - server/runtime.ts
  - server/runtime-pending.ts
  - server/runtime-slot.ts
  - server/runtime-events.ts
  - server/runtime-worker-lifecycle.ts
  - server/runtime-composer-artifacts.ts
  - server/session-projection.ts
  - shared/contracts.ts
  - shared/pending-preview.ts
  - shared/composer-artifact-references.ts
  - shared/resource-references.ts
  - src/api.ts
  - src/controllers/composer-controller.ts
  - src/store.ts
  - src/app-state.ts
  - src/App.tsx
  - src/clipboard-files.ts
  - src/composer-completion.ts
  - src/composer-history.ts
  - src/session-drafts.ts
  - src/composer-keyboard.ts
  - src/model-options.ts
  - src/styles.css
  - src/styles/*.css
  - src/components/ActivityBar.tsx
  - src/components/AttachmentList.tsx
  - src/components/Composer.tsx
  - src/components/ComposerInput.tsx
  - src/components/ImagePreview.tsx
  - src/components/ModelSelector.tsx
  - src/components/ProjectFiles.tsx
  - src/components/Transcript.tsx
  - src/components/transcript-rows.tsx
  - src/components/Welcome.tsx
  - tests/server/app.test.ts
  - tests/server/attachments.test.ts
  - tests/server/composer-history.test.ts
  - tests/server/composer-history-retention.test.ts
  - tests/server/model-catalog.test.ts
  - tests/server/runtime-composer-artifacts.test.ts
  - tests/server/{runtime-pending,runtime-compaction}.test.ts
  - tests/server/session-projection.test.ts
  - tests/web/composer-completion.test.ts
  - tests/web/composer-editor-layout.test.tsx
  - tests/web/composer-controller.test.ts
  - tests/web/composer-history.test.ts
  - tests/web/session-drafts.test.ts
  - tests/shared/composer-artifact-references.test.ts
  - tests/web/composer-sessions.test.tsx
  - tests/web/composer.test.tsx
  - tests/web/model-selector.test.tsx
  - tests/web/store-composer.test.ts
  - tests/server/runtime.test.ts
  - tests/server/pi-operation-lifecycle.integration.test.ts
  - tests/shared/pending-contracts.test.ts
  - tests/web/transcript-inspection.test.tsx
  - tests/web/welcome-new-session.test.tsx
  - tests/browser/workbench.spec.ts
---

# Conversation composer

## Goal

Cover the input modes needed to replace the primary terminal conversation loop.

## Checks

### Text, history, and session partitions

- The composer accepts multiline text. On desktop, a persistent global preference chooses either
  unmodified Enter or Ctrl/Command+Enter as the submit chord; Shift+Enter, Alt+Enter, IME
  composition, and the unselected chord remain multiline input. On a touch-first interaction mode,
  Return always inserts a line break even from an attached keyboard, and only the explicit send
  action submits; this boundary follows `(hover: none) and (pointer: coarse)` rather than viewport
  width or user agent. The chosen chord submits through the visible Steer/Queue delivery selection
  rather than secretly changing delivery mode. Each session keeps its own unsent text, staged
  attachments, and project-file references when the user switches away and back. Unsent text also
  restores after a browser reload in the same tab and Host origin through browser session storage;
  the start surface has a separate text partition. Unsent attachment and project-file partitions
  remain memory-only. History previews do not overwrite the saved pre-browse draft. Handoff,
  explicit clearing, and session deletion remove persisted text; ordinary failed/unknown-delivery
  recovery can restore it through the same draft path. Browsers that deny storage retain the
  in-memory behavior without blocking typing or sending.

  Append-only transcript progress keeps the active textarea instance, focus, and selection intact
  while the session runs. Empty session partitions are discarded, while non-empty partitions remain
  until their user-owned work is sent or removed. `ComposerController` owns the bounded per-session
  attachment/project-file partitions and delivery lifecycle through `AppStore`'s narrow facade;
  `AppStore` remains the sole browser snapshot and cross-domain commit authority.

- Keep the compact input's established padding and control order, with an icon-only send button.
  Controls share a row where space permits and wrap only as needed. On phones, Steer and Queue
  split the full delivery row into equal-width buttons. The input grows with its content.
  A top-right Expand control appears only when text
  exceeds the available compact height and requires internal scrolling, evaluated against the actual
  layout after content or viewport changes. Expanding gives the same input more of the main column;
  Collapse remains available throughout expanded mode, even if subsequent edits shorten the text.
  Collapse restores the compact layout and hides the control if the text now fits. The input reserves
  space for Expand only while the control is visible; ordinary input has no empty overlay gutter.
  The shared active/start editor reacts to wrapping, container width, and visual-viewport changes;
  its height budget reserves room for composer controls even when a software keyboard shrinks only
  the visual viewport, not the main layout.
  Toggling preserves text, attachments, focus, and selection; touch targets remain at least 44px.
  Expansion does not claim Escape from completion, modal, or Stop ownership.

- An active-session composer reproduces Pi's prompt-history traversal. It initializes the
  newest-first history from retained user messages on the selected branch, including messages
  summarized by compaction and after reopening. Other branches do not enter this history. It trims
  entries, suppresses only consecutive duplicates, and retains at most 100 prompts; newly accepted
  prompts join the same in-memory history immediately. Unmodified Up continues ordinary wrapped
  multiline navigation until the caret reaches the first visual line, then moves to the logical line
  start before recalling older entries. While browsing, Down continues ordinary navigation until the
  final visual line, advances toward newer entries, and finally restores the exact pre-browse draft,
  selection, and staged artifacts. Editing a recalled entry exits browsing without mutating an
  earlier message.

  Completion menus and IME composition retain first ownership of their keys, and history changes
  scope with the session/branch projection. Text, embedded images, ordinary attachments, and project
  files are recalled as one prompt. Retained prompts come from branch ancestry, independently of
  Pi's compacted model context and the visible transcript. Their artifacts use branch-bound entry
  identities plus image-part or file-reference coordinates, not mutable context-message offsets,
  until the Host resolves the current projection again: it rehydrates embedded image
  bytes; accepts an ordinary file only while its canonical regular path has durable Inspire upload
  ownership, including after Host restart, never from persisted path text alone; and
  revalidates regular project files against the current workspace realpath boundary again after worker startup,
  immediately before delivery. Missing or changed files fail visibly and remain removable from the
  recalled draft.

  The Host pages exact entries under a serialized byte bound and binds every page to one content
  identity so assistant-only revision advances cannot corrupt newest-first offsets. A lightweight
  Host history version invalidates the browser's payload cache only for history-relevant changes,
  not compaction checkpoints or assistant/tool leaf appends. Cache reuse never substitutes an old
  effective leaf for the current artifact authority. Implementation evidence: [[follow-composer-editing-2026-10-02]].

### Project files and command completion

- Project files can be found through bounded filesystem search, either in the explicit picker or from the
  textarea’s active caret token. An established composer addresses the immutable workspace owned by
  its session; the start surface uses the typed path (or inherited current path) as a read-only
  prospective workspace and binds selected results to its canonical root. Changing that path clears
  staged references, and creation uses the bound canonical root so a symlink retarget cannot
  reinterpret a selected relative file.

  Picker and `@` search expose a default-off Show hidden files control covering dot names and native hidden attributes, not Git ignore rules. Both established and prospective-workspace searches report incomplete scans; Git failure never blocks them.

  Neither search path authorizes prompt access: the prompt boundary revalidates every staged path
  as a regular file contained by the created session’s current canonical workspace, independently of
  search results, hidden visibility, tracking or ignore rules. Selected canonical targets are checked
  again before delivery; a symlink retarget cannot reinterpret a selected reference. `@` completion never treats other mentions as file authority:
  choosing a returned canonical path removes only the active token, preserves the surrounding draft
  and caret, and stages one deduplicated removable file-reference chip.

- Leading `/` completion is offered only while the caret remains inside the command token Pi would
  parse. Once the user types a query, Pi TUI’s public `fuzzyFilter` ranks command names globally
  across sources; descriptions explain results but never admit unrelated commands, while the
  unfiltered inventory remains grouped by source. The browser build resolves that matcher to Pi
  TUI’s pure fuzzy module rather than bundling its terminal-only dependencies. Pi’s runtime commands
  retain source attribution and first wire ownership within the runtime-resource namespace.
  INSΠRE's explicit built-in registry owns all native names before resource dispatch, matching
  Pi's interactive submit handler rather than the lower-level SDK. Namespaced extension commands
  remain available. Terminal-only entries say so in each option's accessible description; a
  first-message surface omits native commands it cannot execute instead of exposing a colliding
  resource under the same name.

  Choosing a result inserts the exact command, adds a trailing space only when it accepts an
  argument, and never executes it implicitly.

- Both completion lists expose loading, empty, and failure states, support pointer and
  arrow/Enter/Tab/Escape interaction with combobox/listbox semantics, suppress stale session
  results, and defer to IME composition, multiline input, steering, and follow-up behavior. The
  multiline textbox keeps DOM focus and owns `aria-controls`, `aria-activedescendant`, and
  autocomplete state inside its named ARIA 1.1 combobox composite. The shared active/start-surface
  `ComposerInput` places each completion surface on the roomier side of the active caret line and
  clamps it to the live center viewport, so start-surface overflow, narrow windows, and
  mobile-keyboard changes cannot clip it.

  It disables browser spelling and grammar proofing: mixed-language technical terms, paths,
  formulas, and model identifiers must not acquire browser-dependent red or blue underlines that
  look like product validation.

### Attachments and image inspection

- Images can be pasted, dropped, or selected. Staged images are distinct thumbnail tiles rather than
  metadata chips: name, MIME, and size stay hidden, removal remains an overlay action, and
  activating a tile opens a focus-contained full-image preview. The shared viewer places a crisp,
  shadowless image above the standard viewport-sized overlay scrim and its 2px backdrop blur. Image
  pixels have a separate opaque, neutral checkerboard inspection background, shared by staged,
  conversation, and file-preview images regardless of format or theme; the scrim never serves as the
  transparency background. Only the image rectangle receives the checkerboard, not the viewer's
  surrounding space.

  A compact keyboard-accessible Checkerboard / White / Black control changes the viewer background
  without changing image bytes, zoom, or pan. It defaults to Checkerboard on each opening and does
  not create a stored preference or scan pixels for alpha. The fitted image and its controls form
  one content-sized, viewport-centered group rather than a fixed-height empty stage: the close
  button sits just above the image at the group's right edge, and the background selector is
  centered directly below the image with balanced spacing. Controls follow the active light/dark
  theme while inspection backgrounds remain theme-independent.

  Viewer controls remain outside the zoom/pan canvas with at least 44px touch targets, and fitting
  reserves room for both control rows and viewport safe areas, including narrow and landscape
  screens. Image activation toggles fit/2× zoom, movement must cross a threshold before a zoomed
  image pans, and only the backdrop, close control, or Escape dismisses it. Native image dragging is
  disabled throughout, so inspecting an image can never restage it into the composer.

  After delivery the owning user turn retains the same inspectable image evidence across refreshes:
  Pi's canonical JSONL keeps the bytes, the bounded transcript projection carries only MIME plus
  stable message/part coordinates, and the session/view-bound resource adapter serves the mounted
  thumbnail without duplicating image bytes into the browser snapshot.

- Ordinary files can be selected or dropped, with their name, type, size, and submission meaning
  visible before sending. A browser paste uses `clipboardData.files` as its one complete source when
  non-empty and falls back to file-kind `clipboardData.items` only when `files` is empty. It never
  combines the two browser projections (which can manufacture two `File` objects for one paste), and
  it never content-deduplicates genuinely distinct files merely because their name, size, type, and
  timestamp coincide.

- Attachment data crosses the trusted host only through bounded, validated operations and is not
  silently uploaded elsewhere by inspire. One shared contract limits a message to eight attachments,
  16 MiB per file, 32 MiB of raw attachment bytes, and 20 MiB of raw image bytes. The browser
  rejects excess staging before upload; the host's multipart storage counts raw file bytes while
  streaming directly into private `0600` upload files and aborts the batch at 32 MiB; prompt
  resolution revalidates totals, encodes images sequentially within a bounded base64 budget, and the
  Pi RPC writer rejects any serialized command line above 32 MiB before touching stdin.

  The matching stdout reader permits only that bound plus a 1 MiB event-envelope allowance, so Pi
  can echo an accepted image message without making the child unbounded or killing it under a
  contradictory 8 MiB cap. Shutdown drains uploads and runtime work before withdrawing staged
  copies; it preserves accepted ordinary files and their ownership metadata.

- Uploads observe headers and the response body within a size-dependent budget: 120 seconds plus
  transfer allowance at 128 KiB/s. Replacing the transport cancels observation; withdrawing the last
  remaining attachment in a batch cancels that batch. A timeout marks surviving chips failed with
  remove/re-add guidance, without resending files or a prompt. Late handles from a transport that
  ignores cancellation are reclaimed. Switching sessions preserves the originating upload owner.

- Withdrawing a staged attachment deletes its owned copy. Delivered images remain embedded in Pi
  message data, so their upload copies can be removed. Sent ordinary files live in durable Inspire
  state storage and remain readable after normal Host restart.

  Reclamation follows retained session references, not process age: scan all entries and branches
  in default/configured Pi storage and remembered custom directories, plus recoverable desktop
  Trash and private deletion-recovery payloads. Shared forks retain the same upload until the last
  reference disappears. Confirmed deletion triggers collection; periodic sweeps detect Trash
  emptying and other reference changes. Incomplete, unreadable, or changing Pi sources defer deletion;
  unrelated valid non-Pi JSONL records in Trash do not block collection merely because of their suffix.
  Staged, in-flight, and accepted-but-unpersisted input and recalled resends remain protected.
  A native input hook's `handled` disposition creates no future-reference hold; actual persisted hook
  references still protect the upload. Scanning and resend leases recognize literal paths and the
  exact JSON-string representation Inspire writes. Only ownership-recorded upload copies are eligible;
  original user/project files are never removed.
  There is no separate cleanup setting or attachment-management surface.

  Browser upload handles still belong to the issuing Host authority, not a WebSocket
  connection. Same-Host reconnect preserves ready uploads; a changed authority marks old handles
  invalid immediately, including inactive session partitions, saved history drafts, and failed
  deliveries. A definitive expiry refusal marks only the named uploads invalid. Invalid attachments
  explain how to remove and re-add them and block another send; recovery never silently reuploads
  a file or resends a message whose delivery outcome is unknown.

### Delivery, native commands, and error ownership

- Input submitted while Pi is active is explicitly sent as steering input or queued as a follow-up.
  `running`, `retrying`, and `queued` are one shared browser/host delivery-state authority, so
  queued work exposes a visible two-option equal-width `Steer` / `Queue` segmented control beside
  abort; the selected mode changes the input placeholder and the send action's accessible name,
  rather than hiding delivery behind a shortcut. `compacting` likewise accepts Steer/Queue and
  remains abortable. Pi's public prompt path cannot accept input during manual compaction; the Host
  holds a bounded, worker/branch-selection-owned temporary delivery queue and resumes at the actual Pi boundary.
  During automatic compaction in prompt preflight, the original prompt remains first; only a real
  active Pi agent receives steering or follow-up directly. A standalone manual compaction instead
  lets the first surviving input start a prompt. Unsent Host-held input is not Pi history and cannot
  cross worker replacement or branch navigation.

  The entire Composer surface carries its slow theme-colored breathing halo only while this
  authority reports `running`, including while a descendant control retains focus; retrying and
  compacting retain their static semantic halos, and reduced-motion retains a static running halo.
  Conflict recovery remains abortable but is not part of active busy ownership. The
  composer-adjacent transient surface names `compacting` and `retrying` from the authoritative
  session run state, independently of manual commands, automatic triggers, or whether this browser
  saw a start event. Retry attempt/reason details enrich that state when available; missing details
  still display `Retrying` without invented counters. Ordinary retry, compaction retry, and
  summary retry keep their short status distinct from any long reason, which wraps within the
  composer width rather than stretching a non-wrapping chip. Pending input appears at the end of
  Transcript, with ordered `S`/`Q` previews visible immediately. Its compact header groups the count,
  Return, Copy and Clear actions; there is no disclosure or separate copy row. ActivityBar retains
  its compact pending count. Executing and failed tools stay in their chronological Transcript cards.
  Pending text previews keep the beginning and end with an explicit middle ellipsis, giving more
  space to the beginning: up to three leading lines and one trailing line within a 512-character
  budget. Short inputs stay whole when they fit, including when an ellipsis would not shorten them.
  Omitted rows retain the total count and a concise count of additional items not shown; there is
  no persistent explanation of preview, copying, or recovery behavior.

  Single-item copy obtains complete text from the Host's matching queue revision and item coordinate.
  Copy all includes every pending message, including rows omitted from the display, in a numbered list
  with all Steer texts before Queue texts. Neither copy removes input or stops Pi. The Host retains
  complete public Pi queue events separately from bounded browser previews; changed coordinates or
  unavailable full content fail visibly rather than copying a preview as complete text.

  Return all removes all input still pending at the public Pi `clear_queue` boundary and from the
  Host's temporary delivery queue without stopping the current task. It restores Steer texts first,
  then Queue texts, preserving order within each group, joined by blank lines and followed by the
  originating session's latest draft. This is one editable draft: original delivery modes and message
  boundaries are not retained, and resending uses the newly selected mode. Consumed messages are not
  recalled. A delayed receipt merges into its original session partition without replacing another
  session's work or a newly typed draft. Explicit Return all restores editor focus only while its
  originating session/view and focus still own the action; a newer focus or modal keeps ownership.

  Stop and unclaimed Escape return pending input to the composer before stopping. The Host also
  clears Pi's queue before its abort boundary and rejects deliveries while Stop is in progress, so
  pending work cannot automatically resume. Recovery bypasses suspended prompt hooks just as Stop
  bypasses the blocked persistence lane; modal/completion Escape ownership and standalone-compaction,
  preflight, and conflict cancellation paths remain intact. A failed Pi clear is reported and Stop
  retires the worker instead of aborting with a live queue.

  Pi's public dequeue returns text only. Inspire retains recoverable copies of images it submits
  while they remain pending. Return all and Stop restore those images as previewable, removable
  attachments alongside the recovered text, preserving the originating session's existing draft and
  attachments, including saved artifacts temporarily hidden by input-history browsing. Recovery
  preserves image order and multiplicity; an over-limit restored draft remains intact and explains
  why it cannot yet send. Images already consumed are not restored; user-discarded input releases
  its copies. These are the original Inspire-submitted images: extension-added or replaced bytes
  are not reconstructed, even when an input hook preserves the caption. Expanded file/reference
  text remains intact. Public Pi supplies no image-presence metadata or item identities; unresolved
  ownership at a consumption/dequeue boundary does not authorize guessing which image to restore. Known text-only recovery is quiet; an image-loss warning requires positive
  evidence of image content that could not be recovered. Still Host-held attachments and references
  are restaged with their originating composer partition, and their rejected delivery does not
  manufacture a second failed-text restore.

  Known original image admissions carry an image count and retained attachment handles. Pending
  displays a compact, wrapping strip of clickable thumbnails alongside any caption, opening the
  shared image viewer. Image bytes load through the existing attachment endpoint, not session or
  queue events; previewing does not transfer ownership. Count-only summaries retain the concise
  Image or N images presentation until retained handles are available. Unknown empty rows do not
  imply an image.
  Once consumed, image admissions leave the public Pending view even if Pi retains their empty
  captions. Preview, full-copy coordinates and recovery use the same unconsumed view across
  settlement and subsequent runs.

  Clear all intentionally discards unconsumed input through the same queue boundary without stopping
  Pi or changing the draft. Clear queue opens the existing Clear all confirmation; X cancels.
  A cleared Host delivery is definitively rejected to its originating operation and releases its
  staged artifacts. There are no pause/resume, per-item delete/convert, second-editor, or browser-owned
  pending-queue paths. Implementation evidence: [[follow-pending-input-recovery-2026-10-02]].

- A shared Pi-native registry covers the installed interactive command vocabulary even though Pi RPC
  does not enumerate built-ins. Browser-owned commands open or invoke existing model, thinking,
  settings, session, branch, copy, naming, new-session, and update surfaces; bounded Host operations
  own compact, HTML export, and runtime-resource reload; terminal-only commands such as scoped-model
  configuration, sharing, trust, login/logout, clone, and import return precise persistent-terminal
  guidance plus a copyable command. Unknown slash commands and `!` shell syntax never silently
  consume a model turn. Native commands reject attachments and project-file references.

  Host operations acknowledge immediately and run outside prompt confirmation timeouts. An active
  export reads the Pi content available at invocation, not a promised future complete answer; it
  does not lock subsequent input. Reload and explicitly starting another compact still refuse while
  Pi work is active. Local/read-only commands remain available regardless of prompt delivery phase.
  Command
  receipts describe that browser's request/results, not Pi's current phase. `/compact` retains its
  eventual success/cancel/error receipt; its running phase is shown only by the state-owned activity
  surface, identical to automatic compaction. A delayed HTTP receipt cannot extend or end that phase.
  Receipt headings show command and outcome, not local request time; receipt metadata retains
  `createdAt` without redundant header timestamps. A successful compact receipt is retired when
  subsequent agent work or compaction begins in that session, while its durable checkpoint remains
  in history. Export and reload retain their named operation receipts. Successful `/copy`, `/name`
  with a new name, `/model` with an exact match, and `/thinking` with a valid level give a brief
  confirmation instead of occupying the receipt dock after settlement; failures retain the
  command's actual diagnostic without a duplicate generic notice. Ordinary controls still give
  their own warning notices on failure. Composer, receipts, and extension widgets share an outer
  width even when either dock scrolls; independent scrollports preserve pointer and keyboard
  scrolling with visible overlay rails. Running receipts use the command and
  phase without invented explanatory progress messages; compaction and other Host commands do not replace the
  editor placeholder with “keep writing” or “send when finished” guidance. Host-adapter labels and
  results must not be represented as verbatim Pi UI copy. Stop/Escape preserves Pending recovery and
  a neutral cancelled receipt under [[pi-integration]]'s native cancellation/completion boundary.
  Reload reports its worker replacement and reset of worker-local extension state. Compaction summaries project as dedicated
  collapsed transcript cards at their persisted position between retained prior messages and later
  messages, including after refresh, repeated compaction, and branch navigation. Model-context
  ordering and session bytes are unchanged. Manual and automatic cancellation/failure produce
  visible outcome notices without requiring a local request receipt or manufacturing a duplicate
  successful summary. Summarization retry wait, attempt counts, and bounded reason are restored from
  Host snapshots; attempts and completion retire that detail without changing the enclosing
  compaction's cancellation semantics. The context meter remains occupancy, never compaction
  progress, and does not suggest invoking another `/compact` while compaction is active. Historical
  checkpoints show persisted tokens-before; after-token estimates remain explicitly labelled in
  the operation receipt and are not fabricated after reload. Review: [[native-command-compatibility]].

- `!command` and `!!command` execute directly through the selected Pi session, not a model prompt
  or project terminal. Both stream and persist a native Bash result; `!` includes it in subsequent
  model context, while `!!` excludes it. Neither form automatically starts a model turn. Shell
  input rejects staged attachments and project references without discarding them.

  Shell execution stays independent of model/compaction state and works during either operation.
  One native shell may run per session; another is rejected rather than queued. Shell-only activity
  leaves ordinary Send available beside Stop without selecting Steer/Queue. Stop uses native Bash
  cancellation when only the shell runs; the model/compaction operation retains first Stop ownership
  when both run. Accepted shell commands participate in input history, including after reopening and
  compaction, with the correct `!`/`!!` prefix. [[pi-integration]] owns execution and hook boundaries;
  [[conversation]] owns output/status presentation. Evidence: [[follow-shell-input-2026-10-02]].

- `/copy` reads the complete last settled assistant text from the Host's authoritative branch
  projection through an authenticated session/view-bound endpoint. It does not start a worker merely
  to read, copy a live partial, trim the original text, or reinterpret a bounded browser preview as
  full content. A changed branch or browser selection invalidates a pending copy before clipboard
  mutation.

- Submitting transfers that exact draft and its staged artifacts into an independently owned
  operation, leaving the editor available for the next message. This synchronous handoff also
  applies to the first message from Welcome; a delayed receipt cannot clear a later draft. A definitively failed or
  acceptance-unknown delivery restores its input if the editor is empty; otherwise a Restore action
  retains it without replacing newer work. Explicitly cleared Pending releases its attachments
  instead of inviting a duplicate retry. Every prompt delivery carries a random
  operation identity and the current process-lifetime Host authority. The Host keeps bounded
  process-lifetime fingerprints and retires old response bodies to tombstones instead of forgetting
  an operation identity: concurrent or near-term copies await or return its one result without
  invoking Pi twice, a retired result fails closed, and changed content under one identity or an
  identity from a replaced Host fails explicitly. The POST owns one delivery, but each HTTP observer
  waits at most 20 seconds before returning an explicit pending receipt. The browser then uses
  authenticated, identity/authority-bound GET observations rather than resending text or attachments.
  Each browser HTTP observation still has a 30-second limit; replacing its transport aborts only
  observation, never Pi's task. Total acceptance may legitimately exceed those local windows.

  After an acceptance-unknown transport, request-timeout, marked-edge, unowned 5xx, or explicit
  Host-reported unknown/retired outcome, a later user retry of the unchanged draft reuses the exact
  operation identity and payload while the Host authority remains unchanged, even if compaction
  completion changed the editor's default delivery mode. A same-Host header
  identifies the respondent, not the operation result: only the retained operation's matched refusal
  (Host authority, operation ID, and rejected outcome) clears the identity. A 401/404/500 from receipt
  observation does not reject the original operation.
  A Host restart requires the user to inspect the refreshed conversation before resending.
  Upload cleanup after confirmed acceptance is best-effort and cannot turn that delivery into an
  apparent rejection. Evidence and limits: [[operation-lifecycle-ownership]]. The project-file picker is one textbox-owned combobox: its input
  keeps DOM focus, exposes the popup with `aria-controls` and the active option with
  `aria-activedescendant`, and owns Arrow/Enter/Tab/Escape while disabled rows are skipped and every
  query generation clears obsolete results before new ones arrive. Closing the popup restores focus
  to its canonical trigger; the mock-host Chromium gate witnesses that Escape path. Home and End
  retain their ordinary editable-search text navigation rather than moving the active option.

  Project-file chips and attachments handed off to one in-flight operation are separate from the
  editable next draft, remain partitioned with other composer artifacts by session, and release only
  on that operation's confirmed acceptance, explicit clear, or user withdrawal after restoration. Pi acceptance remains a successful, non-retryable send even if the
  subsequent disk-projection reconciliation discovers a conflict: the owning sent draft clears, the
  affected worker stops accepting writes, and the conflict remains explicitly recoverable instead of
  inviting duplicate delivery. Failure to confirm worker termination retains its writer fence but
  cannot undo that accepted delivery. Attachment uploads still in flight, failed attachment chips, and
  attachment/project-reference caps prevent submission or staging with non-blocking warning notices
  rather than replacing the session-wide error banner.

  A delayed completion may update its originating session's draft/attachment/status partition, but
  it sets or clears the visible global error only when that session still owns the visible surface.
  Retained failures update the Restore affordance immediately, without waiting for another edit.

### Model controls and new sessions

- The composer displays the selected model, thinking level, and context occupancy as quiet controls
  that do not crowd the writing surface; project identity lives in the topbar per [[workbench]]. Its
  message tools are ordered by decision scope — model, thinking effort, project files, then external
  attachments — before the separate right-aligned context and send/abort state. The responsive
  toolbar follows [[design-system]]: controls retain legible labels or accessible names and stable
  hit areas, including unsupported-thinking and busy states.

  The model picker groups Pi-provided models by canonical provider identity, searches
  provider/id/display fields locally, labels active/recent/capability state, and keeps its search
  and complete catalog reachable in a center-bounded floating menu that repositions above or below
  from the live visual viewport as scrolling, rotation, or a software keyboard changes the available
  space. Only its catalog scrolls, opening does not move an ancestor scrollport, it restores trigger
  focus after Enter, click, or Escape without waiting for asynchronous model ownership, retains that
  focus through a later mutation-error rerender, and uses only successful model changes to maintain
  a bounded global MRU ordering within each provider.

  Unavailable MRU identities stay harmless preference history and are omitted from the current
  projection. A rejected model change never updates active truth or recency; a rejected
  thinking-level change rolls back its optimistic value while its session remains visible. Both
  report a non-blocking warning notice rather than a global error banner.

- The start surface uses the ordinary composer anatomy and the same shared caret-completion input
  and message-tool order as an active session, and accepts text-only, project-file-only, image-only,
  ordinary-file-only, or mixed first messages. Its readiness projection appears only for model
  resolution/selection, a failed default-model resolution with direct retry, or an in-flight start;
  missing project or input is already apparent from the controls and needs no redundant instruction.
  Once ready, the visible project and model controls speak for themselves. It treats Pi's
  `unknown/unknown` absent-model sentinel as no model rather than a selectable worker target, rather
  than leaving a generic disabled button.

  Model, thinking effort, project files, and attachments use the shared toolbar; a full-width
  project address follows below, with its host-directory browser embedded at the address’s left edge.
  While it inherits the visible project, slash completion uses that Pi worker's authoritative extension,
  prompt, and skill commands; after the user explicitly targets
  another directory, commands disappear because no Pi worker has loaded that project's resources
  yet. Session-bound browser-native built-ins appear only after the new session exists; the existing
  Host-owned `/compact` compatibility command remains available on the first-message surface.

  Files remain browser-local until Pi returns the new session identity, then move through the same
  bounded upload/attachment owner and prompt lifecycle as an existing session. A completed upload
  automatically sends the first prompt only while that created session remains selected; otherwise
  its draft and attachments stay with that session for the user to resume. Its writing area grows
  with the draft up to a bounded viewport height. Model and thinking controls inherit the currently
  visible choice when one exists, including a model that arrives after the surface mounts.

  Without an inheritable session model, the host performs a read-only in-memory resolution through
  Pi’s public SDK for the prospective workspace, and the picker displays that real model rather than
  treating an omitted startup argument as an unexplained `Select model` state. The resolved or
  explicitly selected provider/id and supported thinking level are always passed to the creating Pi
  worker before the first prompt; no synthetic `Pi default` option or silent model omission exists.
  A model that does not support reasoning disables thinking instead of inventing a value.

## Non-goals

- The first release does not need a complete project file manager.
- File attachment does not imply arbitrary automatic ingestion of every file format.
