---
purpose: Thinking and tool activity keep stable disclosure identity, bounded lazy bodies, independent density preferences, and Pi-owned lifecycle states.
covers:
  - src/components/transcript-{activity,activity-visibility,fold,row-projection,rows,cards}.ts*
  - src/ansi.ts
  - src/events.ts
  - src/components/Transcript.tsx
  - src/components/ActivityMatrix.tsx
  - tests/browser/activity-presentation.spec.ts
  - src/styles/{transcript,activity-cards}.css
  - server/session-projection.ts
  - tests/web/transcript-{fold,paging}.test.tsx
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
assistant-message boundaries. Thinking, tool and generic content retain
their identities inside it. Displayed custom messages break the group and remain independently readable.

| Density | Presentation |
| --- | --- |
| Expanded | Every item in source order; individual Thinking/Tool preferences still control its content. |
| Compact | Latest 24 items; an Earlier activity control reveals an omitted prefix. Equivalent to Expanded for shorter runs. |
| Collapsed | One left-aligned Activity disclosure. Manual item disclosure and strip selection are retained. |
| Adaptive (`dynamic`) | Historical groups start Collapsed; live groups start Compact and close at the lifecycle boundary below. |

Preferences choose the initial state. Collapsed opens Compact, the Compact prefix opens Expanded,
and the upper/lower boundary controls step downward. When Expanded and Compact are equivalent,
closing skips that intermediate state.

The disclosure has one accessible name and Tab stop, with a shared rounded hover/focus surface.
Enter, Space or pointer activation opens Compact with the group's center reading anchor. Open
groups retain separate upper/lower controls and their reading anchors. On lower collapse, focus
returns to the unified disclosure with `preventScroll`.

Adjacent activity items share one spacing rhythm across assistant-message boundaries; prose and
expanded details retain their own internal spacing.
On fine-pointer desktop layouts, individual activity headers use a 28px minimum height and
adjacent Activity/context-checkpoint groups have an 8px gap. Prose/prompt boundaries retain their
existing spacing, as do narrow/coarse-pointer hit targets. Font sizes and reading line heights do
not change with this density refinement.
A single neutral vertical guide connects the open group's activity. Assistant-turn attribution
rows and divider ticks are absent both inside and outside groups. The group heading uses the
base UI size in the Rajdhani structural-label face with secondary ink; individual identities use
the smaller compact size and medium weight. Lower collapse and Earlier activity controls share the
structural face and base UI size with secondary ink, not a tiny caption.
Type icons use the theme identity colors directly, separate from failure and live-state indicators.
Titles and expanded text use the normal ink/body roles without additional neutral mixing.
Disclosure chevrons lead group labels, item identities and nested call rows. Top-level Activity
and context events share a disclosure axis; the group guide continues under its arrow, and nested
rows begin under the group label. These are visible stroke/letter axes, not equal button edges:
the top-level hit rows hang 7px into the reading gutter to balance their 4px inner inset,
the chevron's intrinsic blank side and the letters' side bearings. Open guides and nested headers follow the corrected axis;
expanded text stays under its own title/name. Row heights and the padded focus/hit surfaces remain.
Rows without retained call detail reserve the disclosure column without adding an inert arrow.

Thinking and tool details open as indented reading content, without an outer frame, tint, or
shadow. Expanded text aligns with its header title. Code, Diff and output keep their local reading
surfaces; a nested tool list has its own shallow guide. Summaries are prose, identities have quiet
medium weight, and metadata remains subdued. A summary is separated from its identity/status group
more clearly than an adjacent expanded-state Copy; shortening Copy spacing must not crowd the summary. Completion/failure marks retain their semantic green/red
in both parent tools and nested calls; live work keeps its running cue. Tool-strip controls likewise avoid permanent boxes; their
selected item remains visibly distinct.

Activity uses a square 3×3 matrix alongside its structural label. Cells represent up to nine
recent individual visible activities, oldest to newest in row-major reading order; a new record
evicts the oldest when full. Tool and Thinking retain their identity colors. Unused cells remain
neutral. Stream deltas and paired tool results do not add entries. Only live individual records
pulse. A partially filled matrix reaching nine records briefly brightens once, retaining a subtle
identity-colored glow while full. Rolling updates do not restart this response; initially full
history does not flash on mount. Reduced motion keeps the static filled appearance. This is chronological data, not the
random seven-pattern Π used for generic loading, and does not claim totals or aggregate success.

Opaque deferred ranges contain bounded presence hints, not individual records. The matrix uses
only the contiguous materialized tail after the last such range, rather than inventing order or
counts from those hints. Its tooltip/accessibility description identifies unavailable history;
expansion populates the matrix from the existing bounded materialization path. No extra history
fetch occurs merely to decorate a collapsed header.

Open activity bodies share one outer rhythm; no redundant trailing card margin is added to the
fold gap. Thinking paragraphs retain reading line-height with a compact paragraph gap and align
with their header text. Empty status slots do not consume header space or push Copy away.

The PWA titlebar needles retain the paired-track motif independently of the transcript folds,
using the active theme's Tool/Thinking identity roles; [[design-system]] owns their presentation.
The unused legacy fold and its isolated stylesheet are not product components to preserve.

Fold-local choice overrides the default and survives pagination, virtualization, pairing changes,
and deferred materialization within the branch view. Manual disclosure stops automatic collapse.

### Deferred history

Older activity-only messages travel as opaque view-bound ranges:

- Expanded loads every bounded page; Compact loads newest-first until it has 24 cards or exhausts
  the range; Collapsed leaves it unloaded.
- The same prefix control represents omitted content, loading, and retry with a matching text label. Selecting it requests
  complete Expanded materialization.
- A projection change invalidates the request. Inserted pages preserve the scroll anchor.
- Compact mounts only its latest 24 activity items; an omitted prefix does not keep tool or
  Thinking renderers alive. Collapsed unmounts the group's items. Manual card disclosure and
  selected tool-strip identity belong to the current projection and survive these omissions.
  Reader choices such as Show all, Arguments/Script and nested-call disclosures, child-call
  inspection, and tool-output scroll offsets are retained by activity and presentation-block key;
  rendered trees and clipboard feedback are not retained. Untouched cards continue to follow their preferences. These choices are released with the
  projection or when their activity disappears.
- If a live append moves the focused item into the omitted prefix, focus moves to Earlier activity
  without scrolling the reading viewport. Expanded restores the retained choices; focus remains
  on the control the reader used.

The Earlier activity control shares the group boundaries’ Rajdhani uppercase structural-label
role and leading disclosure axis. Its square matrix summarizes the last nine known individual
records of the hidden prefix, not the visible latest 24. Opaque ranges remain unknown; the control
does not fetch extra pages merely for decoration. Loading temporarily replaces its chevron with Π;
errors use an explicit alert and retry label. Historical cells stay static unless their own record
is live; current work elsewhere in the group does not animate the omitted prefix.

## Independent card preferences

Thinking supports Adaptive, Expanded, Collapsed, and Hidden. Tool activity additionally supports
Compact. These preferences are independent of the surrounding band's density.

Thinking remains separate from answer text. Terminal control formatting is removed for display;
Pi history remains unchanged. Tool Compact keeps each card header visible with its body closed.
Tool Collapsed groups adjacent runs of two or more calls into a wrapping strip of tool/status glyphs;
isolated calls remain Compact. Selecting a glyph reveals its full card below the strip without
reordering other content.

Empty native Thinking bodies stay closed under Expanded or Adaptive preferences, including
whitespace and display-stripped terminal formatting. Their headers remain available for manual
disclosure; a manual open or close still overrides the default as content arrives. Adaptive residency
starts when displayable content arrives. Configured Thinking presentations can supply content of their
own and retain their normal disclosure behavior.

One native disclosure owns the complete header hit area, including plain summary text and remaining
space. Copy and file-reference controls remain separate siblings above that hit area.
Copy is available only while the individual content is expanded; closed headers reserve no Copy
space or tab stop. In the expanded header it follows the complete header text, including retained
summary metadata, rather than stretching to the row's far edge. Long identities truncate within
the available header; summaries yield space before identity/actions.
Thinking and ordinary tool summaries disappear when expanded to avoid repeating their content;
CodeMode retains its useful duration/call summary. Header hover strengthens ink without
a full-row fill or shadow. Touch press gives local, temporary disclosure feedback, never the
browser's default full-row tap overlay or a sticky hover/selected state. Keyboard focus keeps a
visible rounded outline around the complete disclosure row. Copy and file-reference controls act
independently; only the visible reference opens the resource. Closing content immediately makes its
controls inert, before the exit animation, so Tab cannot re-enter and accidentally reopen it. Child-call disclosures and collapsed tool strips follow the same
pointer/keyboard distinction; a strip's persistent active state still identifies its open item.

Phase and presentation layouts own the gap between output/status and local details; status text
must not add a second block of vertical padding. Script, argument, raw-result and extension-message
details retain native disclosure behavior and use the same thin chevron and compact hit-row treatment.

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

Activity/fold tests cover the single collapsed disclosure and focus return, independent group/item preferences, kind indicators, legacy behavior, density, timing,
identity, pagination, and scroll anchoring. Event tests cover generation, waiting, execution,
settlement, and late updates.
