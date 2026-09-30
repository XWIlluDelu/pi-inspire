---
purpose: Thinking and tool activity keep stable disclosure identity, bounded lazy bodies, independent density preferences, and Pi-owned lifecycle states.
covers:
  - src/components/transcript-{activity,fold,row-projection,rows,cards}.ts*
  - src/ansi.ts
  - src/events.ts
  - src/components/Transcript.tsx
  - src/styles/{transcript,activity-cards}.css
  - server/session-projection.ts
  - tests/web/transcript-{fold,paging,inspection}.test.tsx
  - tests/web/events.test.ts
  - tests/server/runtime-projection.test.ts
---

# Activity disclosure

## Goal

Keep Thinking and tool work inspectable while assistant answers and displayed extension messages
remain directly readable. [[conversation]] owns those content boundaries;
[[tool-presentations]] owns typed card content and configuration.

## Activity bands

Every maximal run of visible non-response activity forms one full-width band between two quiet
rails, including runs crossing assistant-message boundaries. Thinking, tool, generic, and tool-only
round-lead content retain their existing cards inside it. Displayed custom messages break the band.

| Density | Presentation |
| --- | --- |
| Expanded | Every card in source order. |
| Compact | Latest 24 cards; a top `···` reveals an omitted prefix. Equivalent to Expanded for shorter runs. |
| Collapsed | Centered `···` between the rails. Already materialized card state is retained. |
| Adaptive (`dynamic`) | Historical bands start Collapsed; live bands start Compact and close at the lifecycle boundary below. |

Preferences choose the initial state. Manual disclosure follows the same ladder in every mode:
Collapsed opens Compact, the Compact prefix opens Expanded, and either rail steps downward.
When Expanded and Compact are equivalent, closing skips that intermediate state. Rail glyphs point
toward the activity when contracting and away when expanding; adjacent telemetry edges stay parallel.

Fold-local choice overrides the default and survives pagination, virtualization, pairing changes,
and deferred materialization within the branch view. Manual disclosure stops automatic collapse.

### Deferred history

Older activity-only messages travel as opaque view-bound ranges:

- Expanded loads every bounded page; Compact loads newest-first until it has 24 cards or exhausts
  the range; Collapsed leaves it unloaded.
- The same prefix marker represents omitted content, loading, and retry. Selecting it requests
  complete Expanded materialization.
- A projection change invalidates the request. Inserted pages preserve the scroll anchor, and
  materialized children stay mounted across later density changes.

A live omission marker alternates its three 2px square dots between tool/thinking/tool and
thinking/tool/thinking colors once per second. It retains the monospaced cells and 0.25em tracking.
Settled markers are still, failed loads use the error color, and reduced motion uses a static pattern.

## Independent card preferences

Thinking supports Adaptive, Expanded, Collapsed, and Hidden. Tool activity additionally supports
Compact. These preferences are independent of the surrounding band's density.

Thinking remains separate from answer text. Terminal control formatting is removed for display;
Pi history remains unchanged. Tool Compact keeps each card header visible with its body closed.
Tool Collapsed groups adjacent runs of two or more calls into a wrapping strip of tool/status glyphs;
isolated calls remain Compact. Selecting a glyph reveals its full card below the strip without
reordering other content.

The explicit disclosure control and non-interactive header area perform the same open/close action.
Copy and file-reference controls act independently; only the visible reference opens the resource.

## Adaptive timing

Pi events establish completion; dwell times make fast transitions perceptible. The browser keeps the
current assistant-message identity through its tool batch, replaces it at the next LLM call, clears
it on settlement, and restores it from an active reconnect snapshot.

| Surface | Collapse boundary | Minimum residency and delay |
| --- | --- | --- |
| Activity band | Next response or authoritative state showing activity has ended | 2.4 s open and 800 ms after the boundary |
| Thinking | Next assistant message or agent settlement | 1.8 s open and 600 ms after the boundary |
| Individual tool body | Its own `tool_execution_end`, on success or failure | 1.5 s open and 500 ms after completion |
| Tool batch | Next assistant message or agent settlement, after all bodies close | 180 ms body close, then at least 800 ms Compact before collapse |

Settled history starts at its final density without replaying live transitions. Retry remains live;
transport loss alone does not end activity. Terminal worker failure clears browser-only liveness.

Manually opening a completed tool holds its batch open until the reader closes it. Batch collapse
fades cards in place and introduces the strip with a 4px upward fade. Reduced motion skips dwell and
motion transitions; lifecycle eligibility still comes from Pi.

## Tool states and streaming

Call IDs correlate argument generation, execution updates, final results, and failure. Pi's
identity-bearing `toolcall_start` creates the card immediately; legacy starts without identity wait
for the complete call rather than guessing a name.

| State | Display |
| --- | --- |
| Arguments arriving | `Generating arguments…` |
| Observed current-turn call completion, awaiting execution | `Waiting to execute…` |
| Execution started | `Running…`, with cumulative output when available |
| Argument generation interrupted by abort, assistant error, or worker failure | `Not executed`, unless an execution/result receipt supersedes it |
| Settled result | Its actual success/failure outcome |
| Historical or restored call without execution evidence | `No result recorded` |

Execution updates show a bounded text tail separately from the final result. They do not settle the
card or enable final-result copy, and late updates cannot revive a finished tool. Growing argument
and output panes follow their tail while the reader stays at the bottom and preserve manual scrolling.

Native write/edit previews use typed content as arguments arrive. Missing edit fields or newly
started array items retain earlier replacements; an absent side differs from an explicit empty
string. Incompatible tools use their named generic card with partial arguments.

Partial paths are not actionable, and preview copies are labelled partial. Streaming/interrupted
code and replacements show at most 400 lines without an unbounded expansion control. Host preview
limits and redaction are in [[session-transport]]. The authoritative completed call replaces the
preview in the same card and restores normal copy/resource actions. Live and restored failed
messages use the same interruption projection.

## Checks

Activity/fold tests cover density, timing, identity, pagination, and scroll anchoring. Event tests
cover generation, waiting, execution, settlement, and late updates. The browser matrix and streaming
flows are recorded in [[follow-tool-display-review-2026-09-29]].
