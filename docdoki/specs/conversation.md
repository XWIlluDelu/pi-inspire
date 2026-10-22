---
purpose: Pi’s typed messages, thinking, tools, and lifecycle events form one recoverable streaming conversation with independently controllable detail.
covers:
  - src/ansi.ts
  - src/App.tsx
  - src/events.ts
  - src/store.ts
  - shared/assistant-stream.ts
  - shared/assistant-outcome.ts
  - tests/shared/assistant-outcome.test.ts
  - shared/contracts.ts
  - shared/user-turns.ts
  - shared/image-dimension-notes.ts
  - shared/attachment-context.ts
  - tests/shared/attachment-context.test.ts
  - tests/browser/file-attachments.spec.ts
  - src/components/RichText*.tsx
  - src/rich-text-*.ts
  - src/remark-math-boundaries.ts
  - tests/web/rich-text*.{ts,tsx}
  - tests/browser/rich-text-delimiters.spec.ts
  - src/components/ScrollRail.tsx
  - src/components/Transcript.tsx
  - src/components/TranscriptUtilities.tsx
  - tests/browser/reading-navigation.spec.ts
  - src/components/PromptMap.tsx
  - src/components/transcript-activity.ts
  - src/components/transcript-cards.tsx
  - src/components/transcript-fold.tsx
  - src/components/transcript-rows.tsx
  - src/components/transcript-row-projection.tsx
  - src/components/AssistantError.tsx
  - src/components/CustomMessage.tsx
  - src/components/BashExecution.tsx
  - tests/web/native-shell.test.tsx
  - tests/browser/native-shell.spec.ts
  - src/components/transcript-search.ts
  - src/components/transcript-search-highlights.ts
  - src/components/transcript-viewport.ts
  - src/components/ActivityBar.tsx
  - src/components/EarlierBranchBanner.tsx
  - src/components/BranchTree.tsx
  - src/components/Composer.tsx
  - src/components/ExtensionUiDialog.tsx
  - server/runtime.ts
  - server/runtime-events.ts
  - server/session-projection.ts
  - server/session-metadata.ts
  - tests/server/session-metadata.test.ts
  - tests/web/ansi.test.tsx
  - tests/web/events.test.ts
  - tests/web/store*.test.ts
  - tests/web/branch-store.test.ts
  - tests/web/{transcript-search,transcript-actions,activity-visibility,extension-displays}.test.tsx
  - tests/web/assistant-error.test.tsx
  - tests/web/custom-message.test.tsx
  - tests/browser/assistant-error.spec.ts
  - tests/web/transcript-fold.test.tsx
  - tests/web/transcript-paging.test.tsx
  - tests/shared/user-turns.test.ts
  - tests/web/prompt-map.test.tsx
  - tests/web/prompt-map-navigation.test.tsx
  - tests/web/transcript-virtual-search.test.tsx
  - tests/web/transcript-viewport.test.tsx
  - tests/server/runtime-transcript.test.ts
---

# Conversation experience

## Goal

Make the browser a complete, calm, and truthful presentation of an active Pi conversation.

## Contract map

[[activity-presentation]] owns activity bands, independent Thinking/tool density,
deferred materialization, and Adaptive lifecycle. Assistant outcomes and displayed
custom messages remain independent readable boundaries in this contract.

## Source order, rich text, and copy

- User and assistant messages appear in source order without duplicate or missing settled content
  after reconnecting. A keyed message updates only its own key; if an earlier turn lacks its end
  event, the next keyed assistant turn appends rather than overwriting it.

- Markdown math accepts `$…$`, `$$…$$`, `\\(…\\)`, and `\\[…\\]` through token-aware parsing.
  Inline/fenced code and escapes stay code/text; valid same-line, multiline, and newline-adjacent
  displays remain distinct math blocks; first-line display content is never misclassified as
  metadata; and any unclosed opener remains exact readable source while a response streams.
  Dollar delimiters use lexical boundaries so ordinary amounts, whitespace/path-separated Shell
  variables, and bare or quoted regex endings do not consume intervening prose as math. Escaped
  dollars within formulas are preserved, including backslash-run parity. Genuine formula closers,
  including formulas followed by a slash and ordinal suffixes, remain valid.
  Raw HTML-shaped source (including generic types such as `Array<T>`) is rendered as inert text,
  never interpreted as elements or silently discarded.
  Oversized inline formulas scroll locally, like display formulas and code, without widening the
  message. Ordinary inline formulas retain the surrounding text baseline.
  Untrusted Markdown is sanitized before trust-disabled KaTeX generates its complete HTML, MathML,
  and SVG output, preserving extensible glyph geometry and accessibility metadata without enabling
  trust-only commands.

- Copying a selection containing KaTeX writes ordinary selected HTML plus a plain-text source
  projection. Formula bodies use canonical `$…$` inline or `$$…$$` display delimiters, including
  partial selections whose original formula wrapper determines display identity; surrounding
  selected text and multiple formulas are preserved. Every user turn has a message-level action that
  copies its exact source. Every assistant response has an action at the end of the response that
  concatenates only its response text blocks and excludes thinking, tool, custom, and generic
  activity payloads.

  Each Thinking, tool, generic activity block, and displayed custom message independently copies its
  complete source projection; completed-tool copies include the name, arguments, and result under
  the existing Host projection bounds, while a generating/interrupted call explicitly copies only
  its partial argument preview. Custom copies include the type, content, and details.
  [[design-system]] defines the shared Copy/Fork presentation types and activation scopes.

- User turns appear as compact bubbles while assistant answers use an open, left-aligned document
  flow suitable for long Markdown, mathematical notation, code, and structured activity. Unbroken
  links and file references wrap only when needed and remain inside the reading measure at narrow
  widths.

  Image-bearing user messages omit Pi's exact appended image-dimension/coordinate-mapping suffix
  from their bubble, view-local search, Prompt Map and catalog/title projections. Thumbnails and
  image counts remain visible; image-only prompts retain their attachment label. Quoted examples,
  non-suffix text and image omission diagnostics are not filtered. Stored messages, model context
  and complete-source Copy remain unchanged; [[composer]] applies the same omission to recall.

  The exact trailing file-reference context added for Pi is presented as compact filename tags,
  not a prose path list. Image thumbnails and filename tags are grouped before the user’s text,
  with consistent spacing between attachment groups and prose and no extra gap on attachment-only turns.
  Each tag retains its full path in a hover title but grants no file access.
  Default private-upload identifiers are omitted from the label; ordinary project filenames remain
  intact. File-only turns stay visible, file names participate in view-local search, and Prompt Map
  includes file references in attachment counts. Mixed image/file prompts remove the image hint
  before splitting file context. Malformed blocks and quoted examples remain ordinary message text;
  stored/model text and complete-source Copy remain unchanged.

- Project references and artifact handoff follow [[composer]]; preview authorization follows
  [[resource-preview]]. Transcript paths are presentation, not filesystem authority.

## View-local search and Prompt Map

- View-local search explicitly covers only already-loaded settled messages, not the whole branch.
  A full-History action carries its query to the existing complete saved-history search, whose
  scope includes other branches and tool activity. Do not preload all messages or build a new index
  merely to make this local utility look exhaustive.
  View-local search performs case-insensitive literal matching over settled conversation text and
  can scope results to all searchable turns, user input only, or model output only. It wraps
  previous/next navigation and jumps by transcript row through virtualization. The streaming tail
  and hidden thinking/tool payloads are excluded. An active selected match locks out geometric
  latest-follow across prepends and live appends until search is cleared or the user explicitly
  jumps to latest. Deliberate search navigation opens the matching context-summary row so its
  matched body is visible; unrelated rows and ordinary rendering do not expand it.
  Rendered occurrences receive theme-aware highlights without changing message markup, source
  copy or geometry. The current occurrence is stronger and is brought into view within a long
  message or local horizontal reader. Virtual rows and deferred rich text acquire highlights when
  mounted; clearing search or leaving the transcript removes them. Source-only Markdown matches
  still navigate to their row, without assigning an ambiguous source hit to unrelated visible text.
  Shell output and context summaries use the same display normalization for search and rendering:
  terminal control sequences and removed summary prefixes do not add invisible matches.

  Desktop search rests as an explicit compact launcher at the top-right of the reading measure,
  rather than covering the first message with an always-open input. Its open opaque surface fill is subtly
  distinct from the reading stage, with a quiet boundary and no elevation at rest. Hover strengthens
  the boundary and adds the existing light elevation; focus or a non-empty query retains the accent
  boundary. These states do not change its geometry or let scrolling text show through.
  Search and narrow navigation surfaces do not reserve layout height; opening controls preserves the scrollport and reading
  position. Desktop Escape collapses search without clearing its query or selected match; reopening
  restores the query. The local scope note remains beside the full-History action.
  When latest-follow is released, a bottom-centered floating text button, `Jump to latest`, restores
  follow. Search and narrow launchers precede messages in keyboard order; Latest follows them.

  On a narrow workbench, Search is an explicit 44px launcher in an idle control with no shared
  backdrop that floats over Transcript without reserving layout height; activating it replaces the
  launchers with the complete search row on a surface background and focuses the input, while Close,
  Escape, outside dismissal, or a view change clears the hidden search ownership before restoring
  the launchers.

- The Prompt Map is a read-only outline of every visible user turn on the current branch. Its
  branch-bound, bounded index is independent of loaded Transcript pages and History's raw-entry
  window; one shared projection derives its Unicode-safe snippets and image counts consistently for
  loaded, preview, and indexed turns, and selecting an unloaded prompt seeks directly to that turn
  without sequentially scanning older pages or materializing folded activity. At desktop rest it is
  only a floating stack of at most 12 fixed-spacing theme-muted horizontal ticks with one accent
  current mark: no full-height border, background, icon, or boundary buttons.

  Its minimum left reading gutter is derived from the actual center pane rather than the browser
  viewport, and its resting position follows side-pane, reading-measure, and window geometry before
  paint, so resizing in either direction cannot leave the rail over content or at stale coordinates.
  Up to 12 prompts map one-to-one; beyond that, the marks are a stable consecutive window that moves
  only when sequential reading exits it and recenters after a distant seek. Hover or keyboard focus
  expands the bounded, independently scrollable virtual prompt list and its fixed non-wrapping
  Previous and Next controls. Ordinals and attachment counts use the shared small monospace scale
  and readable secondary ink, without a second opacity reduction; the current prompt retains its
  accent emphasis. The ordinal column fits the actual total's digit count and aligns right, so
  one- and multi-digit labels share a text start. Metadata shares the prompt's first-line baseline
  without enlarging its row. Keyboard focus contours stay inside the clipped scrolling rows.
  Leaving the surface collapses it automatically, while touch uses tap
  and outside dismissal. Native disabled semantics and subdued token colors distinguish unavailable
  directions.

  The expanded list initially follows a changed current turn, then yields scroll ownership while the
  user browses it; disclosure preserves keyboard focus, and only one seek may own navigation until
  it succeeds or exposes an exact-target retry. At the authoritative Transcript latest boundary, the
  current mark is the final prompt even when a tall viewport leaves that prompt below the ordinary
  reading line. On a narrow workbench, the desktop vertical rail is removed: a 44px launcher joins
  Search in the backdrop-free idle top-right control floating over Transcript, and activation
  replaces those launchers on a shared surface in the same floating zone with the desktop navigator
  rotated 90 degrees—Previous at left, at most 12 fixed-spacing vertical prompt marks in the center,
  and Next at right.

  The same local-window and disabled-boundary semantics remain; selecting the center marks opens the
  complete independently scrollable virtual directory as a bounded sheet, and outside dismissal
  restores the two Search and Prompt Map launchers. Search and Prompt Map modes are mutually
  exclusive. While either local tool owns focus or its narrow mode, Escape resolves that tool before
  the global run-abort shortcut. Sparse seek windows remain explicitly separated in Transcript,
  while same-branch pagination, append snapshots, branch rewrites, search ownership, and
  latest-follow preserve their existing authorities. Outline loading, conflict resync, turn reads
  and the eventual scroll share the original session/view owner; crossing an await cannot recapture
  another session. Component regressions exercise both loaded and unloaded destinations across a
  409/resync gate and selection change.

## Response streaming and message-owned outcomes

- Assistant text streams smoothly without visually rebuilding the entire transcript for every
  fragment. Pi 0.84 JSON/RPC `message_update` frames intentionally carry only
  `assistantMessageEvent`; the Host reconstructs the active assistant from typed thinking/text
  deltas and identity-bearing tool starts for both live events and reconnect snapshots. Tool
  argument JSON is incrementally parsed and redacted into bounded display-only updates before it
  reaches the browser. Both projections use the same pure reducer, with ordered batching governed
  by [[session-transport]], and resync rather than guessing against settled history. Tool argument
  preview and execution states are specified in [[activity-presentation]]. Pi may emit an empty assistant `message_start` before the provider yields its
  first visible thinking, text, or tool delta; that truthful waiting state renders a quiet
  `Working…` indicator and replaces it immediately when content arrives.

  A settled empty assistant without a terminal outcome allocates no Divider-only transcript row;
  stopped and failed replies retain their visible outcome as specified below. While latest-follow remains
  active, the viewport follows actual rendered-content and scrollport geometry—not only
  message-count or ordinary-text changes—so thinking/tool deltas, Markdown reflow, card transitions,
  virtual-row measurement, and a mobile keyboard resizing the scrollport cannot strand new content
  below the fold. Only an explicit wheel, touch, or keyboard gesture releases latest-follow
  outright.

  A fold disclosure gesture owns its layout mutation before resizing. The unified collapsed
  disclosure keeps the center anchor; open upper/lower controls keep their respective anchors through
  ordinary and virtualized history. It retains latest-follow
  afterward only when the anchored result remains at the exact latest boundary. Input owns the
  viewport before its deferred scroll event, and once released, Markdown reflow, virtual-row
  measurement, scrollport resize, and other programmatic scroll events cannot silently reacquire
  follow; only the user reaching the latest boundary or choosing Jump to latest does so. Transcript
  search retains its separate viewport lock.

- Cancellation is a normal terminal outcome, not a Pi failure. An assistant with
  `stopReason: "aborted"` displays **Stopped** after its partial content,
  outside activity folding. Pi also persists some native cancellations as `stopReason: "error"`
  with the standalone default reason `This operation was aborted`; this exact reason has the same
  presentation. Do not use substring matching: timeout, connection and other diagnostics remain
  errors even when they mention abortion. Runtime settlement, attention indicators and the browser
  agree on cancellation as `aborted`, so it does not activate the Composer's failed styling.
  Native `agent_settled.aborted` determines the run's cancellation outcome even when retry ended
  unsuccessfully or the last assistant message already completed. This leaves original message stop
  reasons, earlier diagnostics and projection conflicts intact. Retry-failure feedback waits for
  settlement, and cancelled background runs do not announce success or failure. A Stop request or
  its HTTP receipt alone does not establish completion.

  Cancellation reuses the error outcome's compact container, padding, title typography and red
  identity colors, with a plain square stop glyph (no surrounding circle) and the **Stopped** label. The 14px glyph uses
  the same header alignment and 8px gap as errors. This visual identity does not change the aborted
  runtime outcome or activate the Composer's failed styling.
  It has no diagnostic subtext, Copy or details controls. Transcript search indexes the visible label,
  not the unshown cancellation diagnostic.
  Partial replies, tools and unsent drafts remain intact. An earlier cancellation cannot suppress
  a later genuine error. Live events,
  reconnect, reduced projections and older pages use the same message-derived classification;
  Pi's stored messages, stop reason and original error text remain unchanged.

- Every other Pi assistant message with `stopReason: "error"` displays its `errorMessage` as a persistent
  plain-text error block after that reply's existing content. Empty and thinking-only failed replies
  remain visible boundaries rather than deferred activity, and activity visibility or
  assistant-round styling cannot hide the error. Short errors are immediately readable; long or
  multiline details have an explicit expand/collapse control and an independent copy action for the
  entire available error text, not its collapsed preview. Existing Host projection bounds still
  apply and visibly mark truncated source. A missing detail retains a truthful no-details fallback.
  The error uses a compact neutral surface with a subtle error-tinted boundary, no shadow,
  a semantic icon/label, adjacent Copy, and a readable reason. Its preview uses the first paragraph, bounded to three lines and
  240 Unicode code points; an intact paragraph does not gain a trailing ellipsis solely because
  diagnostics follow. Expansion keeps the reason in its reading font and at the same horizontal
  anchor. A separately supplied paragraph after the reason becomes a local monospace diagnostic
  surface; unstructured text stays in the reading font. Expanded content is bounded and keyboard
  scrollable. Search navigation also reveals an error's matching details.
  The label, body and details action share a reading anchor; secondary controls use 24px mouse and
  32px touch targets. Semantic error icons and color remain distinct from tool identity.

  Live message completion, reload, reopening, and older-history pagination all derive the outcome
  from the same Pi message, without a second error-history store or a retry/diagnostic subsystem.

- Assistant replies and activity have no per-turn Pi/model/time attribution row or divider rule.
  The Assistant turn details preference is retired. Message metadata remains intact; independent
  error notices and per-tool duration/status are unchanged.

- A displayed Pi custom message is extension-authored context, not a tool execution or user-authored
  turn. It uses a quiet, neutral bordered message surface without a colored edge, a package glyph,
  and a readable type-derived title, distinct from user input and Pi assistant authorship. Raw
  `customType` stays available in complete copy and existing Details rather than repeating in the
  primary header. Its body renders through the shared sanitized Markdown pipeline, supports
  text/image blocks, and stays directly readable regardless of Thinking, tool, or activity-fold
  preferences. Optional non-null `details` gets a separate, initially closed disclosure; absence
  creates no empty entry, and expanded details mount only on demand. A configured reading projection
  may replace the type-derived title with attribution and show a subdued source label, selecting the
  exact body from structured fields. Title and source share a baseline; title, body, and Details share
  a reading anchor, while Copy retains its own column at narrow widths. No timestamp presentation is
  added. Configured messages preserve original type/content/details in lazy Details and complete
  copy. Missing or incompatible declarations retain the generic message, including images and
  unknown blocks. [[tool-presentations]] defines the declarative contract. There is no invented
  execution status or Adaptive lifecycle.

  One semantic message keeps one presentation owner as it crosses Pi’s live lifecycle and durable
  `custom_message` entry: because Pi assigns those forms separate timestamps, the host pairs their
  exact persisted payloads one-to-one in event order, retains legitimately repeated equal payloads
  as separate entries, and replaces rather than appends the linked overlay during snapshots.
  Timestamp adoption and prepends preserve the message's Details state. Older-history and Prompt Map
  paging treat displayed custom messages as visible content boundaries, never deferred tool
  activity. Settled content is searchable in All without being attributed to User or Model.
  `display:false` custom context remains absent from the browser.

  This presentation does not change Pi delivery, model-context conversion, or the existing Pi error
  surface.

- Durable Pi `compaction` and `branch_summary` entries are projected as dedicated, collapsed
  context-event rows with recorded token counts and searchable Markdown bodies. Pi compaction
  shows `Context compacted` and `Before ≈ … tokens` for its pre-compaction context estimate.
  Magic Context shows `Magic Context compacted` and `History chunk ≈ … tokens`: its marker writes
  the historian input chunk estimate into Pi's `tokensBefore` field. Source is read from the public
  compaction entry's `details.source` and projected as `__inspireCompactionSource`; cached source-less
  snapshots also recognize the extension's known marker prefix. Its redundant `Magic Context compacted:`
  body prefix is omitted in display, while Copy retains the recorded summary. No savings ratio is derived.
  These unframed context events use a leading disclosure chevron, source icon, quiet label,
  secondary metric, and an adjacent Copy only while expanded. Closed rows have no Copy gap or tab
  stop. The metric wraps to the label's reading anchor in a narrow column, and expanded Markdown
  shares that anchor without a new outer card. Disclosure and Copy are separate buttons in reading
  order; the disclosure also owns the metric and blank header space, while Copy follows the complete
  header text and never changes disclosure state. Hover strengthens ink only on hover-capable pointers;
  touch press gives temporary local feedback, and keyboard focus keeps a visible outline. Both use the
  shared control radius with non-overlapping 32px touch targets. Closed bodies do not render Markdown.
  Branch summaries have no compaction-before metric. Like Thinking,
  tool, and extension-message headers, they show no timestamp or elapsed-time metadata.
  Canonical timestamps and source content remain unchanged. They are not hidden behind a
  generic-message raw JSON fallback and remain distinct rows at their context boundaries.
  Manual/automatic cancellation and failure have visible outcome notices even without a local
  receipt, not duplicate successful summaries. Host snapshots restore summarization retry wait,
  attempts and bounded reason; attempts/completion retire details without altering compaction's
  cancellation boundary in [[pi-integration]].

- Structured file paths and explicit local file references in conversation content remain
  distinguishable from external web links and can open the owning session’s resource preview.

## Direct shell results

Native `bashExecution` messages are user activity, not assistant tool calls. A readable shell card
shows the exact command with `!`/`!!`, streamed output, running/final exit or cancelled status,
context inclusion/exclusion, and native truncation metadata. **View full output** opens Pi's recorded
log through the same session-authorized resource viewer as assistant-tool output. Worker retirement settles
an unfinished card as Interrupted with retained known output and an unconfirmed result/context;
it does not leave a spinner or invent a native persisted result. It remains visible when
assistant tools are hidden, supports copying the displayed result and metadata, and strips terminal
control sequences without interpreting output as HTML. Live-to-durable reconciliation and reopened
history keep one result per native execution. [[pi-integration]] owns execution and context semantics.

## History, extension interaction, and Pending

- History inspection is read-only. Continue/Edit and independent Fork/Clone are explicit actions
  under [[session-branches]], separate from Git branch selection. Edit confirms only when it would
  replace an existing draft; Edit and Fork prepare the selected input without submitting it. A
  settled user turn exposes a direct fork shortcut keyed by its opaque Pi entry id; the browser
  refreshes the authoritative tree and reuses the same revision-checked fork operation rather than
  implementing a second branch path. A known branch load or action failure remains actionable inside
  this pane and does not duplicate itself into the global error banner.

- Unknown tools and noninteractive extension display messages receive a generic, attributable,
  inspectable fallback instead of disappearing. Available extension name or attribution is the
  primary normal-font title; generic implementation labels such as `custom` and `Extension content`
  are suppressed, with `Extension` as the neutral fallback. Raw method/type and payload remain
  inside the expanded body, subject to host redaction and transport bounds; unsupported future
  response-bearing methods enter the same cancellable dialog model rather than being dropped.

- Concurrent extension dialogs retain arrival order while the oldest is modal. Browser response
  gestures are idempotent; [[pi-integration]] owns Host request/worker validation, deadlines,
  reconnect retention and cleanup. Model settlement does not dismiss an independent command's dialog.

- Pending sits at the end of Transcript; the composer-adjacent activity surface provides a compact
  count and Jump to Pending action. [[composer]] owns previews, visual emphasis, copying, recovery
  and discard. Pending remains a projection of Pi/Host-owned input, not a browser-owned queue.
  Retry/compaction feedback belongs to the activity surface; running and failed tools remain in
  their chronological cards.

- Running, retrying, compacting, queued, user-stopped, failed, and settled states remain
  distinguishable; a user-initiated abort is presented as `Stopped`, not as a failed run.

## Pagination and presentation ownership

- When earlier history exists, each upward return to the transcript's near-top boundary
  automatically requests the next signed, view-bound cursor page; pagination counts visible
  user/response boundaries while representing intervening activity-only message ranges with lazy
  descriptors, so a collapsed run cannot force repeated background pages or transfer its hidden
  body. A short visible page that leaves the viewport inside that boundary continues filling until
  the boundary moves away or history ends. The existing scroll surface owns this one proximity
  check, so loading-state rerenders cannot consume the next trigger, and one automatic fill presents
  one continuous loading state across its bounded page requests.

  Coalesce an in-flight request, prepend only while the session generation, view, incarnation,
  revision, and effective leaf remain on the cursor's append-compatible branch lineage, then restore
  the same visible message at the same viewport offset through virtualization. Same-view append
  snapshots preserve loaded pages, pending ranges, and an in-flight older load behind a changed
  older cursor, while a rewrite or view change cancels and replaces them. Ordinary page failure
  pauses automatic loading and exposes an explicit retry; a stale cursor still resyncs from the
  authoritative snapshot. Deferred range pages retain the same per-message and per-page transport
  bounds and accept an append-only continuation of their owning branch without accepting a sibling
  view.

  The browser explicitly opts into deferred older pages; a tab running the previous bundle across a
  Host restart keeps the complete legacy page response rather than silently dropping activity
  descriptors it cannot interpret.

- Refreshing the browser reconstructs settled conversation state from Pi and then resumes live
  updates. `Transcript` composes canonical rows with bounded collaborators: activity timing owns no
  transcript data, the viewport owns only DOM geometry/cursor loads/follow intent, search owns only
  view-local settled-text state, rows compose turns, and cards render activity variants. No
  transcript collaborator retains a second message projection or changes host pagination authority.

## Non-goals

- Web cards do not have to reproduce ANSI rendering or terminal-only custom components.
- Raw provider payloads and credentials are not part of the browser conversation model.
