---
purpose: Thinking and tool activity keep stable disclosure identity, bounded lazy bodies, independent density preferences, and Pi-owned lifecycle states.
covers:
  - src/components/transcript-{activity-visibility,fold,row-projection,rows,cards}.ts*
  - src/ansi.ts
  - src/events.ts
  - src/components/Transcript.tsx
  - src/components/{BashExecution,ChildCalls,CodeModeResult,CustomMessage,ImagePreview}.tsx
  - src/shell-record.ts
  - tests/browser/activity-presentation.spec.ts
  - src/styles/{transcript,activity-cards}.css
  - server/session-projection.ts
  - tests/web/transcript-{fold,viewport}.test.tsx
  - tests/web/activity-visibility.test.tsx
  - tests/web/events.test.ts
  - tests/server/runtime-transcript.test.ts
---

# Activity disclosure

## Goal

Keep Thinking and tool work inspectable while assistant answers and displayed extension messages
remain directly readable. [[conversation]] owns those content boundaries;
[[tool-presentations]] owns typed card content and configuration.

## Activity groups

Every maximal run of visible non-response activity forms one group, including runs crossing
assistant-message boundaries. Thinking, tool and generic content keep their identities inside it.
Displayed custom messages break the group and remain independently readable.

| Density | Presentation |
| --- | --- |
| Expanded | All activity in source order. |
| Compact | Latest 24 items. Earlier activity reveals the omitted prefix in the same group. |
| Collapsed | Shows the Activity disclosure and matrix. Opening reveals Compact. |
| Adaptive (`dynamic`) | Starts Compact while running and closes when settled unless the reader has opened or is inspecting it. |

The header and footer can collapse an open group. The footer shares the header's disclosure
typography and chevron axis and sits below the group's vertical guide. Earlier activity expands
the omitted prefix in place. The group stays open during inspection and no page controls interrupt
reading.

Adjacent activity items share one spacing rhythm across assistant-message boundaries; prose and
expanded details keep their internal spacing. On fine-pointer desktops, activity headers are at
least 28px high and adjacent Activity groups and context checkpoints are 8px apart.

A single neutral vertical guide connects the open group's activity. Assistant-turn attribution rows
and divider ticks are absent inside and outside groups. The group heading uses Flux Mono at 13px,
secondary ink. Individual identities use the smaller compact size and medium weight. Labels retain intrinsic
layout width; positive 8px gaps separate label and summary without horizontal scaling or
label-length-specific negative margins.

The group header includes a one-line summary in the label's mono face at metadata size (`11.5px`) on the label baseline with quieter ink, separated
by `" · "` like peer tool metadata and built from the same bounded telemetry: the step count, up to
three distinct tool names with repeat counts (Thinking named when room remains), and a failed-call
count in error ink. Deferred ranges add presence to the count without naming tools.
The summary fetches nothing and truncates before the row wraps.

Type icons use the theme identity colors directly, separate from failure and live-state indicators.
Titles and expanded text use the normal ink/body roles without additional neutral mixing.

Disclosure chevrons lead group labels, item identities and nested call rows. Top-level Activity
and context events share a disclosure axis; the group guide continues under its arrow, and nested
rows begin under the group label. The axis is the visible stroke/letter axis, not equal button
edges: top-level hit rows hang 7px into the reading gutter to balance their 4px inner inset, the
chevron's intrinsic blank side and the letters' side bearings. Open guides and nested headers follow
this corrected axis; expanded text stays under its own title/name. Row heights and the padded
focus/hit surfaces are unchanged. Rows without retained call detail reserve the disclosure column
without an inert arrow.

Thinking and tool details open as indented reading content with no outer frame, tint, or shadow.
Expanded text aligns with its header title. Code, Diff and output keep their local reading surfaces;
a nested tool list has its own shallow guide. Thinking summaries use the same subdued typography
as CodeMode duration and call counts. A summary is separated from its identity/status group more
clearly than an adjacent expanded-state Copy is. Tightening Copy spacing must not crowd the summary.
Completion/failure marks keep their semantic green/red in parent tools and nested calls.
Live work keeps its running cue.


Open activity bodies share one outer rhythm; no trailing card margin is added to the fold gap.
The activity heading shows the nine most recent Thinking or tool steps in a 3×3 matrix. Active
steps pulse, and the matrix briefly brightens as the ninth step arrives. The step count and tool
names appear only while the group is open.
Thinking paragraphs keep reading line-height with a compact paragraph gap. Empty status slots
consume no header space and do not push Copy away.

The PWA titlebar needles keep the paired-track motif independently of the transcript folds, using
the active theme's Tool/Thinking identity roles. [[design-system]] owns their presentation.

Manual fold choices survive updates to the same Live turn. Checkpoints keep the turn's identity
while adopting native entry IDs for its rows. A matching Pi tool-call ID keeps deliberate
card and reader choices across pages and checkpoints. Other row-local choices can reset
when the owning native row changes. Older activity loads in the conversation scrollport.

## Independent card preferences

Thinking supports Adaptive, Expanded, Collapsed, and Hidden. Tool activity additionally supports
Compact. These preferences are independent of the surrounding band's density.

Thinking remains separate from answer text. Terminal control formatting is removed for display;
Pi history is unchanged. Tool Compact keeps each card header visible with its body closed.
Tool Compact uses individual tool disclosure rows. Collapsed presents consecutive settled calls
as a strip of tool icons. Choosing an icon opens its card below the strip.

Empty native Thinking bodies, including whitespace-only and display-stripped terminal formatting,
stay closed under Expanded or Adaptive preferences. Their headers remain available, and a manual
open or close still overrides the default as content arrives. Configured Thinking presentations can supply their own content and
keep normal disclosure behavior.

One native disclosure owns the complete header hit area, including plain summary text and remaining
space. Copy and file-reference controls are separate siblings above that hit area and act
independently; only the visible reference opens the resource.

- Copy exists only while the individual content is expanded; closed headers reserve no Copy space
  or tab stop. In the expanded header Copy follows the complete header text, including retained
  summary metadata, instead of stretching to the row's far edge.
- Long identities truncate within the available header; summaries yield space before
  identity/actions.
- Thinking and ordinary tool summaries disappear when expanded, since they repeat the content;
  CodeMode keeps its duration/call summary.
- Header hover strengthens ink without a full-row fill or shadow. Touch press gives local,
  temporary disclosure feedback, never the browser's full-row tap overlay or a sticky
  hover/selected state. Keyboard focus shows a visible rounded outline around the complete row.
- Closing a card unmounts its details. Its header stays available to reopen them.

Phase and presentation layouts own the gap between output/status and local details; status text
adds no second block of vertical padding. Script, argument, raw-result and extension-message details
keep native disclosure behavior with the same thin chevron and compact hit-row treatment.

## Adaptive activity

Pi events establish completion. Active Thinking and tools start open. An individual tool closes
when it reports a result. A group returns to its settled density at the next visible response or
when the run settles. A manual disclosure keeps its choice across settlement. Focused activity
stays open while the reader is inspecting it. Retry remains live and transport loss keeps the last
confirmed lifecycle state.

## Tool states and streaming

Call IDs correlate argument generation, execution updates, final results, and failure. Pi's
`toolcall_start` creates the card immediately. The Host publishes the affected tool's bounded
activity record for Live and includes the same record in a reconnect snapshot. Native execution
events do not carry partial results to the browser. The final result arrives as a transcript row.

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
started array items keep earlier replacements; an absent side differs from an explicit empty
string. Incompatible tools use their named generic card with partial arguments.

Partial paths are not actionable, and preview copies are labelled partial. Streaming/interrupted
code and replacements show at most 400 lines without an unbounded expansion control. Host preview
limits and redaction are in [[session-transport]]. The authoritative completed call replaces the
preview in the same card and restores normal copy/resource actions. Live and restored failed
messages use the same interruption projection.

## Checks

Component tests exercise fold choice, bounded pages and native checkpoint continuity. Browser
tests exercise keyboard disclosure and reading while activity settles. Event tests exercise tool
phases and late updates.
