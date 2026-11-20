---
purpose: Pi’s typed messages, thinking, tools, and lifecycle events form one recoverable streaming conversation with independently controllable detail.
covers:
  - src/ansi.ts
  - src/App.tsx
  - src/events.ts
  - src/store.ts
  - shared/assistant-stream.ts
  - shared/assistant-outcome.ts
  - shared/contracts.ts
  - shared/user-turns.ts
  - shared/image-dimension-notes.ts
  - shared/attachment-context.ts
  - tests/shared/user-message.test.ts
  - tests/browser/file-attachments.spec.ts
  - src/components/RichText*.tsx
  - src/rich-text-*.ts
  - src/remark-math-boundaries.ts
  - tests/web/rich-text*.test.tsx
  - tests/browser/rich-text-delimiters.spec.ts
  - src/components/Transcript.tsx
  - src/components/TranscriptUtilities.tsx
  - tests/server/native-turn-history.test.ts
  - src/components/transcript-activity-visibility.tsx
  - src/components/transcript-cards.tsx
  - src/components/transcript-fold.tsx
  - src/components/transcript-rows.tsx
  - src/components/transcript-row-projection.tsx
  - src/components/AssistantError.tsx
  - src/components/CustomMessage.tsx
  - src/components/BashExecution.tsx
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
  - tests/web/{transcript-search-highlights,content-copy,activity-visibility}.test.tsx
  - tests/browser/{transcript-search,extension-ui}.spec.ts
  - tests/web/assistant-error.test.tsx
  - tests/browser/custom-message.spec.ts
  - tests/browser/assistant-error.spec.ts
  - tests/web/transcript-fold.test.tsx
  - tests/browser/history.spec.ts
  - tests/web/live-transcript-search.test.tsx
  - tests/web/transcript-viewport.test.tsx
  - tests/server/runtime-transcript.test.ts
area: "Conversation & Content"
---

# Conversation experience

## Goal

Make the browser a complete, calm, and truthful presentation of an active Pi conversation.

## Contract map

[[activity-presentation]] owns activity bands, independent Thinking/tool density,
activity detail, and Adaptive lifecycle. [[rich-rendering]] owns Markdown, mathematics
and code rendering. Assistant outcomes and displayed custom messages remain independent readable
boundaries in this contract.

## Source order, rich text, and copy

- User and assistant messages appear in source order without duplicate or missing settled content
  after reconnecting. A keyed message updates only its own key; if an earlier turn lacks its end
  event, the next keyed assistant turn appends instead of overwriting it.

- The transcript projects assistant content into response and activity rows in source order.
  Search reads the displayed response passages, and activity summaries use the same items as
  their cards. Ordinary and virtualized rows share the same turn and search anchors.

- Copying a selection containing KaTeX writes ordinary selected HTML plus a plain-text source
  projection. Inline formulas use `$…$`; display formulas put each `$$` delimiter on its own line,
  preserving internal formula whitespace. This also applies to partial selections, where the
  original formula wrapper determines display identity; surrounding selected text and multiple
  formulas are preserved.

  A user turn copies its exact source. Copy response appears after the final text block and copies
  the assistant entry's response text. Saved user, assistant, and custom copies read the original
  entry on demand through the paged History content channel. Custom content and details remain
  complete, embedded image bytes travel separately, and changing the source view retires pending
  copies.

  Each Thinking, tool, and generic activity block independently copies its complete source
  projection. Completed-tool copies include the name, arguments, and result under the existing Host
  projection bounds; a generating/interrupted call explicitly copies only its partial argument
  preview. Custom copies include the type, content, and details. [[design-system]] defines the shared
  Copy/Fork presentation types and activation scopes.

- User turns appear as compact bubbles; assistant answers use an open, left-aligned document flow
  suited to long Markdown, mathematical notation, code, and structured activity. Unbroken links and
  file references wrap only when needed and stay inside the reading measure at narrow widths.

  Image-bearing user messages omit Pi's exact appended image-dimension/coordinate-mapping suffix
  from their bubble, view-local search and catalog/title projections. Thumbnails and
  image counts remain visible; image-only prompts keep their attachment label. Quoted examples,
  non-suffix text and image omission diagnostics are not filtered. Stored messages, model context
  and complete-source Copy are unchanged; [[composer]] applies the same omission to recall.

  The exact trailing file-reference context added for Pi is presented as compact filename tags,
  not a prose path list. Image thumbnails and filename tags are grouped before the user's text, with
  consistent spacing between attachment groups and prose and no extra gap on attachment-only turns.
  Each tag keeps its full path in a hover title but grants no file access. Default private-upload
  identifiers are omitted from the label; ordinary project filenames stay intact. File-only turns
  stay visible, file names participate in view-local search, and History includes file references
  in attachment counts. Mixed image/file prompts remove the image hint before splitting file
  context. Malformed blocks and quoted examples remain ordinary message text; stored/model text and
  complete-source Copy are unchanged.

- Project references and artifact handoff follow [[composer]]; preview authorization follows
  [[resource-preview]]. Transcript paths are presentation, not filesystem authority.

## Search in Live and History

- View-local search covers already-loaded settled messages, not the whole branch. Its input tooltip
  states that limit. Scrolling and the Prompt Map load the saved portions of the branch in the same view.

  Search performs case-insensitive literal matching over settled conversation text and can scope
  results to all searchable turns, user input only, or model output only. Previous/next navigation
  wraps and jumps by row across the loaded transcript. The streaming tail and hidden
  thinking/tool payloads are excluded. An active selected match locks out geometric latest-follow
  across Live updates until search is cleared or the user explicitly jumps to latest.
  Deliberate search navigation opens the matching context-summary row so its matched body is
  visible; unrelated rows and ordinary rendering do not expand it.

  Rendered occurrences receive theme-aware highlights without changing message markup, source copy
  or geometry. The current occurrence is stronger and is brought into view within a long message or
  local horizontal reader. Deferred rich text acquire highlights when mounted;
  clearing search or leaving the transcript removes them. Source-only Markdown matches still
  navigate to their row, without assigning an ambiguous source hit to unrelated visible text. Shell
  output and context summaries use the same display normalization for search and rendering, so
  terminal control sequences and removed summary prefixes add no invisible matches.

  Desktop search floats as a compact single-row input at the top-right of the reading measure. A
  top inset clears the first row and positions revealed matches below the search control.
  Ctrl/Cmd+F in the conversation, its composer or header focuses/selects its text without
  an extra launcher. Escape blurs the desktop input while preserving its query, highlights and
  selected match; clearing the input releases match ownership. IME composition, modal and contextual
  surfaces keep their keyboard ownership. Local-tool placement follows [[design-system]]: the
  launcher and working surface form one interaction rather than disconnected destinations.

  [[design-system]] owns the search surface and states. Search and narrow navigation surfaces
  reserve no layout height. Session/view changes retire search state. Width changes keep an active
  query visible in the corresponding desktop or narrow tool.

  On narrow screens, equal-sized Search and Prompt Map buttons float at the transcript's top-right.
  The Prompt Map icon echoes the navigation bar's vertical ticks. The transparent toolbar takes
  no layout height. A top inset keeps the first row's actions below the buttons.
  Opening a tool preserves the scrollport and reading position. Prompt Map has a Close button in
  both the compact navigation bar and the expanded prompt list. It dismisses the whole tool and
  returns focus to its launcher.
  Search replaces the launchers with a floating input across the reading width, focusing
  and selecting its text. Close or Escape clears the query and match ownership, closes the input,
  and restores focus to its local launcher. An outside press dismisses narrow Search. The scope
  choice stays inside the shared search field.

  A bottom-centered floating text button, `Jump to latest`, appears only when the scrollport is
  actually away from its latest boundary, independently of automatic-follow or search ownership.
  It restores follow at the complete Transcript bottom, including Pending and extension content
  after message rows. The search row and narrow tool launchers precede messages in keyboard order;
  Latest follows them.

- Scrolling toward the top of the conversation reads successive bounded native History pages
  before the oldest live message. Prepending a page preserves the visible row and its offset.
  The desktop ScrollRail follows the same scrollport. The Prompt Map shows current-branch
  user turns with a hover disclosure and tick navigation. On narrow screens its launcher is
  in the conversation tools. The map opens all targets in the same scrollport. At an unloaded
  target it reads a bounded window around that prompt and continues paging in either direction.

## Response streaming and message-owned outcomes

- The Host applies Pi's thinking, text and tool updates to the active assistant. It sends the
  browser a complete message or an ordered batch bound to that message and transcript revision.
  The Host parses and redacts tool arguments before sending bounded previews. Both sides apply the
  same reducer, and an inconsistent batch triggers resync. [[session-transport]] defines batch
  ordering and [[activity-presentation]] defines tool states.

  Pi may emit an empty assistant `message_start` before the provider yields its first visible
  thinking, text, or tool delta; that waiting state renders a quiet `Working…` indicator, replaced
  immediately when content arrives. A settled empty assistant without a terminal outcome allocates
  no Divider-only transcript row; stopped and failed replies keep their visible outcome as specified
  below.

  While latest-follow is active, the viewport follows actual rendered-content and scrollport
  geometry, not only message-count or ordinary-text changes. Thinking/tool deltas, Markdown reflow,
  disclosure and a mobile keyboard resizing the scrollport therefore
  cannot strand new content below the fold. Only an explicit wheel, touch, or keyboard gesture
  releases latest-follow outright.

  Focusing activity pauses latest-follow while the reader inspects it. Dynamic thought, tool and
  activity disclosures stay open briefly after settling. Saved activity begins in its settled
  state. Reduced motion skips the added minimum durations and animations. Activity pages keep
  navigation within the group. Input owns the
  viewport before its deferred scroll event. Once follow is released, only reaching the latest
  boundary through user scrolling or choosing Jump to latest resumes it. Transcript search keeps
  its separate viewport lock.

- Cancellation is a normal terminal outcome, not a Pi failure. An assistant with
  `stopReason: "aborted"` displays **Stopped** after its partial content, outside activity folding.
  `stopReason: "error"` remains an error, including the standalone diagnostic
  `This operation was aborted`: diagnostic text does not establish cancellation. Runtime
  settlement, attention indicators and the browser use native cancellation evidence, not
  error-message wording, to identify an `aborted` run, without failed Composer styling. Native
  `agent_settled.aborted` determines the run's cancellation outcome even when retry ended
  unsuccessfully or the last assistant message already completed; original message stop reasons,
  earlier diagnostics and projection conflicts stay intact. Retry-failure feedback waits for
  settlement, and cancelled background runs announce neither success nor failure. A Stop request or
  its HTTP receipt alone does not establish completion.

  Cancellation reuses the error outcome's compact container, padding, title typography and red
  identity colors, with a plain square stop glyph (no surrounding circle) and the **Stopped** label.
  The 14px glyph uses the same header alignment and 8px gap as errors. This visual identity does not
  change the aborted runtime outcome or activate the Composer's failed styling. There is no
  diagnostic subtext, Copy or details control. Transcript search indexes the visible label, not the
  unshown cancellation diagnostic. Partial replies, tools and unsent drafts stay intact. An earlier
  cancellation cannot suppress a later genuine error. Live events, reconnect, reduced projections
  and older pages use the same message-derived classification; Pi's stored messages, stop reason
  and original error text are unchanged.

- Every other Pi assistant message with `stopReason: "error"` displays its `errorMessage` as a
  persistent plain-text error block after that reply's existing content. Empty and thinking-only
  failed replies remain visible boundaries, not deferred activity; activity visibility and
  assistant-round styling cannot hide the error.

  The error shows a semantic icon and label, adjacent Copy and a readable reason on the surface
  [[design-system]] defines. Short errors are immediately readable. Long or
  multiline details have an explicit expand/collapse control; Copy copies the entire available error
  text, not the collapsed preview. Existing Host projection bounds still apply and visibly mark
  truncated source. A missing detail shows a truthful no-details fallback.

  The preview uses the first paragraph, bounded to three lines and 240 Unicode code points; an intact
  paragraph gains no trailing ellipsis just because diagnostics follow. Expansion keeps the reason
  in its reading font at the same horizontal anchor. A separately supplied paragraph after the
  reason becomes a local monospace diagnostic surface; unstructured text stays in the reading font.
  Expanded content is bounded and keyboard scrollable. Search navigation also reveals an error's
  matching details. The label, body and details action share a reading anchor; secondary controls
  use 24px mouse and 32px touch targets. Semantic error icons and color stay distinct from tool
  identity.

  Live message completion, reload, reopening, and older-history pagination all derive the outcome
  from the same Pi message, with no second error-history store or retry/diagnostic subsystem.

- Assistant replies and activity have no per-turn Pi/model/time attribution row or divider rule.
  Message metadata, independent error notices and per-tool duration/status remain intact.

- A displayed Pi custom message is extension-authored context, not a tool execution or user-authored
  turn. It has a package glyph and a readable type-derived title, distinct from user input and Pi
  assistant authorship, on the surface [[design-system]] defines. Raw
  `customType` stays in complete copy and existing Details instead of repeating in the primary
  header. The body renders through the shared sanitized Markdown pipeline, supports text/image
  blocks, and stays directly readable regardless of Thinking, tool, or activity-fold preferences.
  Optional non-null `details` gets a separate, initially closed disclosure that mounts only on
  demand; absent details create no empty entry.

  A configured reading projection may replace the type-derived title with attribution, show a
  subdued source label, and select the exact body from structured fields. No timestamp is shown. Configured messages preserve original type/content/details
  in lazy Details and complete copy. Missing or incompatible declarations fall back to the generic
  message, including images and unknown blocks. [[tool-presentations]] defines the declarative
  contract. There is no invented execution status or Adaptive lifecycle.

  One semantic message keeps one presentation owner as it crosses Pi's live lifecycle and durable
  `custom_message` entry. Because Pi gives those forms separate timestamps, the host pairs their
  exact persisted payloads one-to-one in event order, keeps legitimately repeated equal payloads as
  separate entries, and replaces (does not append) the linked overlay during snapshots. Timestamp
  A live custom message remains inspectable through its checkpoint. Its saved native row keeps
  the complete content accessible through History.
  Settled content is searchable in All without being attributed to User or Model.
  `display:false` custom context stays absent from the browser.

  This presentation does not change Pi delivery, model-context conversion, or the existing Pi error
  surface.

- Durable Pi `compaction` and `branch_summary` entries are projected as dedicated, collapsed
  context-event rows with recorded token counts and searchable Markdown bodies. They are not hidden
  behind a generic-message raw JSON fallback and stay distinct rows at their context boundaries.
  - Pi compaction shows `Context compacted` and `Before ≈ … tokens` for its pre-compaction context
    estimate. Branch summaries have no compaction-before metric. No savings ratio is derived; Copy
    keeps the recorded summary.
  - Source-specific titles, metric meanings and redundant-prefix elision come from external
    checkpoint declarations under [[tool-presentations]], not extension-name tests in the renderer.
    Source is read from the public compaction entry's `details.source` and projected as
    `__inspireCompactionSource`; optional declared prefixes cover cached source-less snapshots.
  - Rows are unframed: a leading disclosure chevron, source icon, quiet label, secondary metric, and
    an adjacent Copy only while expanded; closed rows have no Copy gap or tab stop and do not render
    Markdown. In a narrow column the metric wraps to the label's reading anchor; expanded Markdown
    shares that anchor without a new outer card.
  - Disclosure and Copy are separate buttons in reading order. The disclosure also owns the metric
    and blank header space; Copy follows the complete header text and never changes disclosure
    state. Hover strengthens ink only on hover-capable pointers; touch press gives temporary local
    feedback, and keyboard focus keeps a visible outline. Both use the shared control radius with
    non-overlapping 32px touch targets.
  - Like Thinking, tool, and extension-message headers, they show no timestamp or elapsed-time
    metadata. Canonical timestamps and source content are unchanged.
  - Manual/automatic cancellation and failure have visible outcome notices even without a local
    receipt, not duplicate successful summaries. Host snapshots restore summarization retry wait,
    attempts and bounded reason; attempts/completion retire details without altering compaction's
    cancellation boundary in [[pi-integration]].

- Structured file paths and explicit local file references in conversation content stay
  distinguishable from external web links and can open the owning session's resource preview.
  Ctrl/⌘+click instead shows the file in the Host's file manager under [[resource-preview]].

## Direct shell results

Native `bashExecution` messages are user activity, not assistant tool calls. A readable shell card
shows the exact command with `!`/`!!`, streamed output, running/final exit or cancelled status,
context inclusion/exclusion, and native truncation metadata. **View full output** opens Pi's recorded
log through the same session-authorized resource viewer as assistant-tool output. Worker retirement
settles an unfinished card as Interrupted with retained known output and an unconfirmed
result/context, not a spinner or an invented native persisted result. The card stays visible when
assistant tools are hidden, supports copying the displayed result and metadata, and strips terminal
control sequences without interpreting output as HTML. Live-to-durable reconciliation and reopened
history keep one result per native execution. [[pi-integration]] owns execution and context semantics.

## History, extension interaction, and Pending

- A settled user turn offers Fork under [[session-branches]], addressed by its saved Pi entry id.
  The title menu offers saved branches and Clone.

- Unknown tools and noninteractive extension display messages receive a generic, attributable,
  inspectable fallback instead of disappearing. Available extension name or attribution is the
  primary normal-font title; generic implementation labels such as `custom` and `Extension content`
  are suppressed, with `Extension` as the neutral fallback. Raw method/type and payload stay inside
  the expanded body, subject to host redaction and transport bounds. Unsupported future
  response-bearing methods enter the same cancellable dialog model instead of being dropped.

- Concurrent extension dialogs keep arrival order while the oldest is modal. Browser response
  gestures are idempotent; [[pi-integration]] owns Host request/worker validation, deadlines,
  reconnect retention and cleanup. Model settlement does not dismiss an independent command's dialog.

- Pending sits at the end of Transcript, with a compact jump button near the Composer.
  The activity surface above the Composer owns retry and compaction feedback. Running and failed
  tools stay in their chronological cards. [[composer]] owns Pending presentation and actions.
  Pending is a projection of Pi/Host-owned input, not a browser-owned queue.

- Running, retrying, compacting, queued, user-stopped, failed, and settled states remain
  distinguishable; a user-initiated abort is presented as `Stopped`, not as a failed run.

## Pagination and presentation ownership

- The scrollport fetches saved windows in bounded pages pinned to their native leaf. A newer
  prompt jump supersedes an in-flight page request. A failed read keeps the confirmed rows and
  retries the requested location. Jump to latest reconnects the viewport to live output.
- Live uses the bounded tail and native checkpoint updates. Manual scrolling or inspecting
  content pauses follow. If a checkpoint cannot confirm a live row, keep the output visible
  with an unconfirmed indication.

## Non-goals

- Web cards do not have to reproduce ANSI rendering or terminal-only custom components.
- Raw provider payloads and credentials are not part of the browser conversation model.
