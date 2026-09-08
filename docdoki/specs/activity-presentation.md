---
purpose: "Thinking and tool activity retain semantic disclosure identity, bounded deferred materialization, independent density preferences, and Pi-owned lifecycle timing."
covers:
  - src/components/transcript-{activity,fold,row-projection,rows,cards}.ts*
  - src/ansi.ts
  - src/components/Transcript.tsx
  - src/tool-presentations/**
  - src/styles/transcript.css
  - server/session-projection.ts
  - tests/web/transcript-{fold,paging,inspection}.test.tsx
  - tests/server/runtime-projection.test.ts
---

# Activity folds and adaptive disclosure

## Goal

Offer inspectable activity without hiding assistant outcomes or extension-authored content,
duplicating transcript data, or inferring runtime lifecycle from animation. Reading, errors, and
custom-message boundaries remain in [[conversation]]; typed tool rules are specified in
[[tool-presentations]].

## Checks

### Activity bands and deferred materialization

- Every maximal run of visible non-response activity before, between, or after assistant response
  passages is projected into one full-width band bounded by two quiet horizontal rails, even when
  the run crosses assistant-message boundaries. Expanded preserves the existing Thinking, tool,
  generic, and tool-only round-lead presentation unchanged inside the rails. Displayed custom
  messages are independent content boundaries outside activity folds. Compact preserves the latest
  24 cards in source order; with at most 24 it is presentation-equivalent to Expanded, while a
  longer run hides only its earlier prefix behind a top `···` control that expands the complete run.

  Collapsed is the most compressed state: it retains any materialized source and card state while
  showing only centered `···` between the rails. Manual disclosure follows one setting-independent
  density ladder: a Collapsed middle or rail opens Compact, Compact's prefix `···` opens Expanded,
  and either rail reduces Expanded to Compact and Compact to Collapsed. At both boundaries the glyph
  points in the next spatial direction—toward the activity when an open band can contract and away
  from it when a Collapsed band can expand—and the adjacent telemetry edges run parallel to the
  glyph sides. When Compact and Expanded are equivalent, collapse skips the invisible intermediate
  state.

  Expanded, Compact, and Collapsed preferences choose the initial state rather than disabling any
  manual transition; fold-local choice is retained by the branch view across pagination, virtual
  unmounting, pairing changes, and activity-range materialization and overrides its default. Older
  pagination leaves activity-only persisted messages behind an opaque, view-bound range instead of
  transferring them merely to hide them. Expanded automatically materializes every bounded page;
  Compact materializes newest-first pages only until 24 cards are available or the range is
  exhausted; Collapsed remains unloaded. The same minimal prefix `···` represents loaded or deferred
  omission, loading, and retry without a separate on-demand text card; selecting it requests
  complete Expanded materialization.

  A changed projection invalidates the request, every inserted page is scroll-anchored, and
  already-materialized children remain mounted across later presentation changes. The independent
  default is Adaptive (persisted as `dynamic`): historical runs start Collapsed, live runs start
  Compact—therefore matching Expanded for ordinary runs of at most 24 cards—and then close only
  after both 2.4 seconds from opening and 800 ms from the next response or authoritative runtime
  state proving that no further activity can arrive. Manual disclosure halts that automatic
  transition. Retry remains live, transport loss alone proves nothing, and worker failure clears
  browser-only streaming/tool liveness so a terminal tail cannot remain open forever.

- An activity band's existing omission marker uses three 2px square dots, retaining the original
  monospaced ellipsis cells and 0.25em tracking. It indicates live work by alternating them between
  tool/thinking/tool and thinking/tool/thinking theme colors once per second. Both the collapsed
  summary and any visible omission control share this local CSS feedback; it adds no polling or
  runtime messages and does not create a control where none is needed. Settled bands remain still,
  loading errors retain their error color, and reduced motion keeps a static color pattern.

### Independent Thinking and tool disclosure

- Thinking appears separately from answer text and follows the user’s independent Adaptive,
  Expanded, Collapsed, or Hidden preference. Adaptive keeps every Thinking block from the current
  LLM call expanded through its tool batch, then requests collapse when the next assistant message
  starts or the agent settles; collapse waits for both 1.8 seconds of expanded residency and 600 ms
  after that boundary. Historical loading starts collapsed and never replays lifecycle motion.
  Terminal-only control formatting is dropped at the display boundary without rewriting Pi history.

- Each tool call is correlated with its live status, partial output, final result, and failure
  state.

- Tool activity supports Adaptive, Expanded, Compact, Collapsed, and Hidden defaults in decreasing
  information density. Adaptive treats every assistant message’s tool calls as one Pi batch: each
  call requests Compact at its own `tool_execution_end`, independent of its peers and of success or
  failure; the entire batch requests Collapsed together only when the next assistant message starts
  or the agent settles. A call remains Expanded until both 1.5 seconds from opening and 500 ms from
  its own completion have elapsed; after the 180 ms body-close transition the Compact cards remain
  visible for at least 800 ms before the batch collapses. A settled historical batch loads directly
  as Collapsed. Compact keeps every ordinary card visible with its body closed.

  Collapsed turns each adjacent call into a tool/status glyph pair in a wrapping horizontal strip
  without reordering across other content; selecting one reveals its complete card downward beneath
  the strip, with animated open, close, and selection changes. Both ordinary and Collapsed-strip
  activity headers provide an explicit local disclosure control, while every non-interactive part of
  the header invokes the same expand/Compact action. Copy and resource-preview controls remain
  independent: only the visible resource reference opens that resource, and neither control also
  changes disclosure state.

### Adaptive lifecycle and native tool content

- Pi lifecycle events determine when Adaptive mode may advance; monotonic dwell deadlines only keep
  very fast states perceptible and never infer lifecycle. The browser retains the current
  assistant-message identity from `message_start` through its tool batch, replaces it at the next
  LLM call, clears it on settlement, and restores it from an active snapshot after
  refresh/reconnect. Each completed tool becomes Compact independently after its minimum Expanded
  residency. Once every card is Compact and the batch has met its minimum Compact residency, the
  full-size cards fade in place and Collapsed tiles enter with a restrained 4px upward fade—there is
  no cross-node geometry flight. Reduced motion switches immediately.

  Manually expanding a completed full-size tool pauses that batch’s collapse until the user closes
  it; a Collapsed tile remains directly inspectable through its downward detail reveal.

- Known Pi-native tools resolve through the shared tool-presentation registry while retaining
  the ordinary card shell and lifecycle. `read`, `write`, `edit`, `bash`, `grep`, `find`, and
  `ls` render typed file, code, patch, terminal, match, and listing blocks; a successful edit
  uses Pi's persisted authoritative patch and never recomputes workspace state. Rule bodies
  remain lazy, and a missing, failing, malformed, or shape-incompatible selected rule returns
  directly to the generic raw card. Complete copy actions continue to project the original
  arguments and result.

- A tool result recognized as a unified diff renders as typed, tinted lines (added, removed,
  context, hunk, file markers) instead of a raw dump, and is never truncated; recognition is strict
  enough that prose with leading `-`/`+` characters is never recolored.
