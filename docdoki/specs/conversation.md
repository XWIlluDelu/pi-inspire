---
purpose: Pi’s typed messages, thinking, tools, and lifecycle events form one recoverable streaming conversation with independently controllable detail.
covers:
  - src/ansi.ts
  - src/App.tsx
  - src/events.ts
  - src/store.ts
  - shared/assistant-stream.ts
  - shared/contracts.ts
  - shared/user-turns.ts
  - src/components/RichText.tsx
  - src/components/ScrollRail.tsx
  - src/components/Transcript.tsx
  - src/components/PromptMap.tsx
  - src/components/transcript-activity.ts
  - src/components/transcript-cards.tsx
  - src/components/transcript-fold.tsx
  - src/components/transcript-rows.tsx
  - src/components/transcript-row-projection.tsx
  - src/components/AssistantError.tsx
  - src/components/CustomMessage.tsx
  - src/components/transcript-search.ts
  - src/components/transcript-viewport.ts
  - src/components/ActivityBar.tsx
  - src/components/EarlierBranchBanner.tsx
  - src/components/BranchTree.tsx
  - src/components/Composer.tsx
  - src/components/ExtensionUiDialog.tsx
  - server/runtime.ts
  - server/session-projection.ts
  - tests/web/ansi.test.tsx
  - tests/web/events.test.ts
  - tests/web/store*.test.ts
  - tests/web/branch-store.test.ts
  - tests/web/transcript-inspection.test.tsx
  - tests/web/assistant-error.test.tsx
  - tests/web/custom-message.test.tsx
  - tests/browser/assistant-error.spec.ts
  - tests/web/transcript-fold.test.tsx
  - tests/web/transcript-paging.test.tsx
  - tests/shared/user-turns.test.ts
  - tests/web/prompt-map.test.tsx
  - tests/web/transcript-virtual-search.test.tsx
  - tests/web/transcript-viewport.test.tsx
  - tests/server/runtime-projection.test.ts
---

# Conversation experience

## Goal

Make the browser a complete, calm, and truthful presentation of an active Pi conversation.

## Contract map

[[activity-presentation]] owns activity bands, independent Thinking/tool density,
deferred materialization, and Adaptive lifecycle. Assistant outcomes and displayed
custom messages remain independent readable boundaries in this contract.

## Checks

### Source order, rich text, and copy

- User and assistant messages appear in source order without duplicate or missing settled content
  after reconnecting. A keyed message updates only its own key; if an earlier turn lacks its end
  event, the next keyed assistant turn appends rather than overwriting it.

- Markdown math accepts `$…$`, `$$…$$`, `\\(…\\)`, and `\\[…\\]` through token-aware parsing.
  Inline/fenced code and escapes stay code/text; valid same-line, multiline, and newline-adjacent
  displays remain distinct math blocks; first-line display content is never misclassified as
  metadata; and any unclosed opener remains exact readable source while a response streams.
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

- User turns appear as compact bubbles while assistant answers use an open, left-aligned document
  flow suitable for long Markdown, mathematical notation, code, and structured activity. Unbroken
  links and file references wrap only when needed and remain inside the reading measure at narrow
  widths.

- Composer project-file selections are display handles, not durable filesystem authority. At prompt
  delivery the Host resolves the workspace and each candidate through real paths and accepts only
  regular files contained by the current canonical workspace. Discovery membership, hidden visibility
  and Git ignore rules do not authorize references. Symlink retargets fail closed; becoming ignored
  does not revoke a still-valid selected file. File references added to the prompt are
  JSON string literals under an explicit context heading, so filename newlines or list markers
  cannot create new prompt instructions. A transport replacement invalidates in-flight prompt/upload
  ownership; stale completions cannot clear current composer state, and uploaded bytes completed on
  the old transport are reclaimed.

### View-local search and Prompt Map

- View-local search performs case-insensitive literal matching over settled conversation text and
  can scope results to all searchable turns, user input only, or model output only. It wraps
  previous/next navigation and jumps by transcript row through virtualization. The streaming tail
  and hidden thinking/tool payloads are excluded. An active selected match locks out geometric
  latest-follow across prepends and live appends until search is cleared or the user explicitly
  jumps to latest.

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
  Previous and Next controls; leaving the surface collapses it automatically, while touch uses tap
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
  latest-follow preserve their existing authorities.

### Response streaming and message-owned outcomes

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

  A settled empty assistant without an error allocates no Divider-only transcript row; failed
  replies instead retain their visible error outcome as specified below. While latest-follow remains
  active, the viewport follows actual rendered-content and scrollport geometry—not only
  message-count or ordinary-text changes—so thinking/tool deltas, Markdown reflow, card transitions,
  virtual-row measurement, and a mobile keyboard resizing the scrollport cannot strand new content
  below the fold. Only an explicit wheel, touch, or keyboard gesture releases latest-follow
  outright.

  A fold disclosure gesture owns its layout mutation before resizing and keeps the selected upper,
  lower, or middle anchor fixed through ordinary and virtualized history; it retains latest-follow
  afterward only when the anchored result remains at the exact latest boundary. Input owns the
  viewport before its deferred scroll event, and once released, Markdown reflow, virtual-row
  measurement, scrollport resize, and other programmatic scroll events cannot silently reacquire
  follow; only the user reaching the latest boundary or choosing Jump to latest does so. Transcript
  search retains its separate viewport lock.

- Every Pi assistant message with `stopReason: "error"` displays its `errorMessage` as a persistent
  plain-text error block after that reply's existing content. Empty and thinking-only failed replies
  remain visible boundaries rather than deferred activity, and activity visibility or
  assistant-round styling cannot hide the error. Short errors are immediately readable; long or
  multiline details have an explicit expand/collapse control and an independent copy action for the
  entire available error text, not its collapsed preview. Existing Host projection bounds still
  apply and visibly mark truncated source. A missing detail retains a truthful no-details fallback.

  Live message completion, reload, reopening, and older-history pagination all derive the outcome
  from the same Pi message, without a second error-history store or a retry/diagnostic subsystem.

- Assistant round boundaries have two presentation-only styles: Divider replaces the existing
  Pi/model/time/stop-reason row with a quiet neutral rule centered in the ordinary inter-turn gap,
  while Details preserves that row unchanged. A message carrying response text places this one
  boundary with its first response passage rather than inside preceding collapsible activity; a
  tool-only message retains it with its first activity. Divider color never implies hidden status.

- A displayed Pi custom message is extension-authored context, not a tool execution or user-authored
  turn. It uses a quiet, neutral message surface with an information-blue left edge, package glyph,
  readable type-derived title, and the available `customType`, distinct from user input and Pi
  assistant authorship. Its body renders through the shared defensive Markdown pipeline, supports
  text/image blocks, and stays directly readable regardless of Thinking, tool, or activity-fold
  preferences. Optional non-null `details` gets a separate, initially closed disclosure; absence
  creates no empty entry, and expanded details mount only on demand. There is no invented execution
  status or Adaptive lifecycle.

  One semantic message keeps one presentation owner as it crosses Pi’s live lifecycle and durable
  `custom_message` entry: because Pi assigns those forms separate timestamps, the host pairs their
  exact persisted payloads one-to-one in event order, retains legitimately repeated equal payloads
  as separate entries, and replaces rather than appends the linked overlay during snapshots.
  Timestamp adoption and prepends preserve the message's Details state. Older-history and Prompt Map
  paging treat displayed custom messages as visible content boundaries, never deferred tool
  activity. Settled content is searchable in All without being attributed to User or Model.
  `display:false` custom context remains absent from the browser.

  This presentation does not change Pi delivery, model-context conversion, or the existing PI error
  surface.

- Durable Pi `compaction` and `branch_summary` entries are projected as dedicated, collapsed
  context-summary cards with retained token counts and searchable Markdown bodies. They are not
  hidden behind a generic-message raw JSON fallback and remain distinct rows at their context
  boundaries.

- Structured file paths and explicit local file references in conversation content remain
  distinguishable from external web links and can open the owning session’s resource preview.

### History, extension interaction, and Pending

- The contextual History mode shows the bounded Pi conversation tree, active path, and effective
  leaf; it is unrelated to Git branch selection. Branch switching, edit-from-here, and fork are
  explicit confirmed actions; edit and fork copy the original user text into the destination
  composer without auto-submitting it, and unsupported root-user edit is visibly unavailable. A
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

- Concurrent extension dialogs are retained in arrival order by Pi request id while the oldest is
  modal. Responses are idempotent in the browser, revalidated inside the host mutation gate, and
  remove only their owning request. Positive Pi timeouts are bounded and mirrored with host expiry
  timers; expiry, settle, abort, worker replacement/exit, and close remove stale requests, and
  snapshots restore only live requests.

- The user can send steering input during work and queue follow-up input for after completion.
  Pending is a quiet, bounded, text-only projection of public Pi `queue_update` events with separate
  Steer/Queue FIFO order and omission markers; its local row keys are not authoritative Pi item IDs.
  Complete visible text may be copied, but a truncated or omitted preview cannot be copied as full
  text. Explicitly confirmed Clear all invokes Pi's public `clear_queue` for whatever remains at the
  operation boundary; it is not a fallback for pause or an implicit side effect of Abort/Escape.
  There is no pause/resume, per-item mutation, conversion, second editor, or browser-owned pending
  queue.

  The composer-adjacent surface is limited to automatic retry plus a concise `N Pending` count;
  running and failed tools remain in their chronological cards.

- Running, retrying, compacting, queued, user-stopped, failed, and settled states remain
  distinguishable; a user-initiated abort is presented as neutral `Stopped`, not as a failed run.

### Pagination and presentation ownership

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
