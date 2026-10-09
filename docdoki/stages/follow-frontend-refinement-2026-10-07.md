---
scope:
  - src/components/
  - src/styles/
  - src/{source-diff,file-icons,syntax-highlighting}.ts
  - tests/web/
  - tests/browser/
  - docdoki/specs/{workbench,conversation,workspace-layout,activity-presentation,resource-preview,model-settings,interface-preferences,design-system,terminal,composer,session-branches}.md
---

# Incremental frontend refinement

## Objective and review contract

Continue frontend improvement in small, independently reviewable batches. The user wants to see
each batch's concrete net changes before proceeding, not review a large redesign all at once.
Prioritize beauty, consistency, readability and intuitive interaction.
Propose each next batch before implementation and wait for the user's approval; approval of one
slice does not authorize the following slice.

Feedback rejecting particular visual changes applies to those changes, not automatically the entire
batch or all future frontend work. Preserve independent, useful changes. The agent owns routine
implementation decisions and must assess each change's purpose and dependencies rather than
repeatedly asking the user to classify scope.

Clear functional defects and vulnerabilities can normally be fixed and retained independently of
visual preferences. Such fixes do not replace the frontend-improvement objective. The previous
statement that frontend refinement was closed or restricted to bug fixes was an agent
misinterpretation, superseded by the user's clarification.

## Current baseline

- Reading controls: floating Search, narrow launchers, Prompt Map and the bottom-centered text
  `Jump to latest` retain their established layout. `TranscriptUtilities` separates presentation
  from existing search and viewport ownership (`42ac55b`).
- Activity: preserve double rails, tool/Thinking segments, middle dots, geometry and turn dividers.
  Collapsed activity is one native button with shared feedback and one Tab stop. Open boundaries
  remain independently operable; collapsing below restores focus without scrolling (`e6d4b32`).
- Files: the content-sized index/full-body narrow preview experiment was withdrawn. Current layout,
  Recent's reserved height and navigation remain unchanged. Retained cleanup hides unavailable
  Source/Preview actions and removes Notebook Markdown gutter labels without changing alignment
  (`a9693b5`).
- Changes: active-change navigation preserves red/green addition/deletion backgrounds and retains
  the existing edge marker (`5c16908`). Source highlighting and filename-appropriate icons
  (`d486a07`) are retained after the user moved to the next batch.
- Authentication: settled login results supersede earlier request errors and late responses
  (`a098b26`).

The accepted Models batch below is retained at `f085a42`. Main Settings categories are accepted at
`4cdcf70`; Terminal categories are accepted at `4a65392`. Attachments/Pending are accepted at
`e96c3ea` with deliberate idle dimming restored. Narrow Thinking grouping is accepted at `acbcf3f`;
Command Palette headings are accepted at `71769cf`; Pending header action order is retained at
`1013f42`. Quiet secondary buttons are accepted at `a5ad7e7`. The session-row overflow experiment
below is withdrawn. For ongoing sequential frontend work, use the main worktree; isolation requires
a concrete need rather than a generic precaution.
Execution Pi sessions use normal persistent storage, remain discoverable in Inspire and are retained
for the user's occasional inspection. Finishing a task is not grounds to delete those session records.

## Verification to reuse

Reading/activity restoration reused existing behavior evidence and targeted the new disclosure/focus
behavior. Files cleanup passed its two focused component cases. Changes color regression was
reproduced and verified in Chromium. Authentication response-order cases were reproduced before the
fix; the authentication/model-settings component suites, type checking and lint passed afterward.
Frontend assets have been rebuilt for the current implementation.

Do not repeat full suites or visual matrices for unchanged behavior. Verify the actual net change
and relevant failure modes, then stop.

## Changes readability — retained baseline

Implemented as `d486a07`; retained while work continues on Models.

- Changes uses the existing Source highlighting facility, palette, typography and row geometry.
  The Host's full-context diff supplies independent old/new revisions; multiline token spans are
  balanced for each rendered row. Deletions use old-source semantics (including original filename
  language on renames); additions and shared context use the selected new source. Unknown or
  oversized revisions retain escaped plain text under the existing 64 Ki-character bound.
- Changed-file rows use filename-based monochrome Lucide categories at the existing 13px size,
  with `FileText` fallback. Files itself, reading controls, activity rails and Models remain untouched.
- Focused regression cases cover multiline nested spans, independent revisions, renamed languages,
  escaping, per-revision size limits, literal row rendering and file icons. The four relevant
  Vitest files passed; typecheck, repository lint and changed-file Biome checks passed.
- One focused Chromium assessment used the existing mock browser Host, without restarting the user
  Host. Light/dark captures show the shared syntax palette and icons, including highlighted edits
  with the retained red/green backgrounds and active edge. A browser assertion checked literal
  source selection/clipboard copying, token color, unchanged 22px rows and the 13px file icon.
  Existing navigation-color regression evidence was reused, not expanded into another matrix.
- Browser assets are rebuilt. Before/after artifacts are in
  `output/playwright/changes-readability/`: `before-{light,dark}.png`,
  `after-{light,dark}.png` and `after-change-{light,dark}.png`.

## Models choices — accepted and preserved

Implemented from `d486a07`, with the indicator finish aligned with Settings controls at `f085a42`.
Accepted by the user; this category-navigation batch preserves those controls.

- Common exact membership uses native checkboxes; Default uses native radios and is idempotent
  when reselected. Clear remains in the saved-default summary. Rule inclusion has a separate
  “Via rule” edit action with source-pattern attribution, not a dashed/indeterminate checkbox.
- Provider headings are quiet labels without repeated shaded bands or bottom borders. Existing
  list bounds, row capacity, model typography, default/thinking summaries, section order,
  declaration forms and authentication presentation remain. Obsolete chip styles are removed.
- The action grid explicitly navigates the full filtered model list and mounts distant targets
  before focusing them. Radio arrows/Home/End select; Common navigation only moves focus. Saves
  preserve the focused input unless the user moves away. Pi storage/API semantics are unchanged.
- The 19-case Models component suite passed, with updated control roles and focused assertions
  for idempotent selection and rule attribution. A new Chromium regression checks distant-row
  navigation, radio wrapping, independent Common membership, Tab, save focus and summary Clear;
  the existing responsive default-row case also passed. Prior auth and model-workflow evidence
  was reused. Typecheck, repository lint, changed-file Biome and the web build passed.
- Chromium visual inspection used the mock browser Host at 1280px and 390px, in light/dark;
  desktop Jade checks reused the same roles. The rule action opened its actual saved pattern.
  Evidence is in `output/playwright/models-refinement/`: `before-light.png`,
  `after-{light,dark}.png`, `after-narrow-{light,dark}.png`,
  `after-selected-light.png`, `after-rule-light.png` and `after-jade-{light,dark}.png`.
  Browser assets are rebuilt. The user's Host and global model preferences were not touched.
- The indicator follow-up replaces browser-native strokes/fills with Settings control surfaces,
  hairlines, accent tints and precise checkbox ticks/radio dots. Native inputs, labels, handlers,
  dimensions, focus and disabled styling remain; forced-colors mode keeps native indicators.
- One focused mock-browser check confirmed label activation, Space/Tab, save focus, the 2px keyboard
  outline and unchanged indicator/label geometry. Amber/Jade light/dark spot-checks matched indicator
  surface, border and mark colors to actual Settings switches. CSS lint added no diagnostics; the
  web build passed. Prior component, virtualized-keyboard and narrow-layout evidence remains valid
  and was not rerun.
  `choice-style-{light,dark}.png` show the finish beside real Settings switches in the same artifact
  directory; earlier screenshots remain intact.

## Settings categories — accepted and preserved

Implemented from the clean `f085a42` main worktree. Category content, field order, icons, desktop
sidebar, dialog frame and footer geometry remain; only category visibility/navigation and the narrow
selected treatment change.

- Display, Conversation, Behavior, Models and System are separate views. The selected page starts at
  its content top, including when reselected. Scrolling stays within the selected category.
- Inactive pages remain mounted but hidden from rendering, focus and assistive technology. This
  preserves provider/model and rule editors, model browsing, loaded data and authentication lifetime.
  Models keeps its destination owner across switches and defers destination scrolling and save-focus
  handoffs while hidden. Manage models and credentials reveal their intended section.
- The narrow category strip drops the selected card border, fill and shadow, leaving one accent
  underline. Desktop selection, keyboard outlines, touch dimensions and horizontal reachability remain.
- Four focused Vitest files passed (33 cases): Settings navigation/loading, modal focus and Models.
  Chromium checks passed for dropdown Tab, desktop/320px category visibility/top landing, stable
  selection during scroll, hidden-control focus/Tab exclusion, an initially hidden virtualized catalog,
  retained search/provider draft, delayed login arriving while hidden, retained login input/completion,
  credentials navigation and Manage models' prospective-project owner across category switches.
  Typecheck, repository lint, changed-file TS/TSX lint and the web build passed.
- Before/after screenshots in `output/playwright/settings-categories/` show 1280px desktop and 390px
  narrow Conversation views. Final Amber light/dark and narrow Jade light/dark captures were visually
  inspected; `visual-check.log` records theme/palette identity and the single narrow selected treatment.
  Baseline captures are `before-{desktop,narrow}-light.png`; final captures are
  `after-{desktop,narrow}-{light,dark}.png` and `after-narrow-jade-{light,dark}.png`.
  Verification uses the isolated mock browser Host, not user preferences or the running user Host.
  Browser assets are rebuilt; temporary mock processes are stopped.

## Terminal categories — accepted and preserved

Implemented from the clean `4cdcf70` main worktree following the user's approval of the analogous
Terminal category navigation. The accepted main Settings and Models controls are unchanged.

- Appearance, Interaction and Saved output now occupy separate category views. They reuse the
  main Settings desktop sidebar and narrow underline strip. Switches and reselection land at the
  content top; scrolling does not select another category.
- The modal owns browser preferences and Host load/save/clear/error state throughout navigation.
  Only the selected section mounts; this excludes inactive controls and their portaled menus
  without adding a category framework. Existing fields, immediate saves, confirmation policies,
  browser-only Restore defaults and footer save errors remain.
- The Terminal content scroller flexes within the sidebar/main layout. Desktop frame and field tokens
  remain; the narrow frame now uses the same safe-area-aware available height as main Settings.
  Multi-option controls move below their labels on narrow cards, using the shared wide-field styling.
  Desktop/narrow captures were inspected in Amber light/dark, and
  Jade accent roles were checked against actual root theme/palette attributes. A 700px tablet
  check confirmed label/control separation and untruncated control labels in all three categories.
- Four new component cases passed for page isolation/top landing, immediate browser persistence
  and reset separation, delayed Host loading/saving while hidden, and retained clear progress/errors.
  The existing terminal pane (21 cases) and UI storage (3 cases) suites passed; the pane focus case
  now observes the initial Appearance view. Four Chromium cases passed across 1280px/320px:
  category scroll/selection, hidden Tab exclusion, keyboard-visible focus, portaled-menu dismissal,
  and the existing browser/Host controls, confirmations and reopen workflow with explicit categories.
  Typecheck, repository lint, changed-file Biome and the web build passed.
- Evidence in `output/playwright/terminal-categories/`: `before-{desktop,narrow}-light.png`,
  `after-{desktop,narrow}-{light,dark}.png`, component/browser logs, `fit.log` and
  `visual-check.log`. Final narrow viewport fit and refreshed light/dark captures passed after the
  frame refinement; the Interaction page and footer fit at 390×900. The isolated mock Host was used
  throughout; user preferences, real terminals
  and the user's service were not changed. Temporary mock/browser resources are stopped; the
  normal persistent execution session is retained.

## Attachments and Pending — accepted and preserved

Implemented from clean `4a65392` in the main worktree after the user's approval to continue.
The accepted Terminal, main Settings and Models slices are preserved. Accepted at `e96c3ea`
with the user's idle/interaction hierarchy restored.

- File chips show filename, existing upload/error state and removal. Native tooltips retain full
  filenames, MIME/size or recalled-file provenance and error diagnostics; error icons also expose
  their diagnostic to assistive technology. Image tiles and recalled/persisted image loading remain.
  File labels shrink without squeezing icons/actions, and chips retain their compact height beside
  thumbnails. No attachment authority or budget changes.
- Pending retains the user's deliberate secondary-information treatment: 0.75 overall opacity,
  transparent background and quiet border at rest, with full opacity/shared surface/hairline on
  hover or focus within. The attempted removal of idle dimming was rejected and restored; it was
  intentional hierarchy, not a readability defect. The header shows one quiet total. Complete single-mode queues use `Pending · Steer` or
  `Pending · Queue` without another group heading; mixed or incomplete previews retain quiet group
  labels. Group counts, row S/Q badges and their grid column/styles are removed. Numbering, ordering,
  omitted disclosure, exact copy targets, image previews and action handlers remain.
- Composer toolbar, Model/Thinking, delivery controls, Stop/Send, ActivityBar Pending count,
  reading controls, activity rails and Files layout are unchanged.
- The two focused component suites passed (14 cases), including both single modes, mixed ordering,
  bounded-summary truth, filename/tooltips, upload/error/removal and disabled states. Three relevant
  Chromium cases passed for thumbnail/viewer/narrow wrapping, Clear confirmation/draft preservation,
  complete-copy/mixed recovery and Stop/Escape. The image fixture now supplies five thumbnails in
  one row group to verify wrapping after removal of the badge column frees enough room for four.
  Typecheck, repository lint, changed-file Biome and the web build passed.
- Visual inspection used isolated mock content at 1280px and 390px in Amber light/dark, with desktop
  Jade light/dark spot-checks after waiting for actual root theme/palette attributes. Captures include
  mixed and complete single-mode Pending, chart thumbnails, long filenames and ready/upload/error
  files. At 320px, browser assertions confirmed page/chip/action fit and reachable Clear confirmation.
  Evidence: `output/playwright/composer-hierarchy/` contains
  `before-{desktop,narrow}-light.png` and component/browser/static-check logs. The earlier
  normal-opacity after-captures are superseded by the restored idle/interaction treatment and removed.
  CSS restoration reuses the unchanged action/geometry evidence above. A focused Chromium CLI check
  confirmed idle opacity 0.75, hover/focus-within opacity 1, and return to 0.75 after leaving the panel;
  refreshed evidence is `restored-{idle,hover,focus,narrow}-light.png` and `restore-visual.log`.
  Browser assets are rebuilt; no real user sessions, queues, attachments
  or preferences were changed. Temporary mock/browser resources are stopped; the normal persistent
  execution session is retained.

## Narrow Thinking grouping — accepted and preserved

Implemented from clean `e96c3ea` in the main worktree. The user selected only Thinking adjacency
from the screenshot comparison; accepted at `acbcf3f` with filled red Stop preserved.

- Two CSS values change at widths up to 420px: the selector gap uses `--space-2` (8px), and Model
  uses shrink-only flex sizing. Thinking keeps its existing non-shrinking width; available space,
  not a fixed model quota, determines truncation. Desktop, Stop/Send, Steer/Queue, textarea,
  attachments and Pending are unchanged.
- Three focused Chromium mock probes passed: 390px with Kimi K3 and 320px/360px with a long model
  label. All measured an 8px gap, aligned controls, fully visible Thinking and no page overflow.
  Long labels truncated while Thinking stayed fully visible. Stop retained its filled error color.
  Final screenshots were compared with the selected narrow sketch and visually inspected.
- Evidence: `output/playwright/thinking-group/after-narrow-light.png`, `after-long-320-light.png`,
  `geometry.log` and `build.log`. The web build passed. Validation used an isolated mock Host;
  no real preferences, models or sessions were changed. Temporary probes and mock resources are
  removed, and the normal execution session is retained.

## Command Palette headings — accepted and preserved

Implemented from clean `acbcf3f` in the main worktree; accepted at `71769cf` when the user requested
the next batch. Only `.palette__group` changes:
its control-surface fill and bottom hairline are removed. Existing muted semibold type, case,
padding and section gaps keep groups readable without competing with command-row highlights.
Input focus/boundary, palette frame, row treatments, hints, order and handlers are unchanged.

- Inspected real before/after Chromium captures at 1280×900 light and 390×900 dark using the isolated
  mock Host. Short Help and longer Workspace/Sessions groups retain a clear rhythm; the light
  panel loses its repetitive strips, and dark headings remain legible on the shared surface.
- One focused CLI browser check traversed all 15 default command rows across groups: the last
  candidate scrolled fully into view while focus stayed in Filter commands. Theme search/Enter
  dispatch was exercised while capturing. Existing palette interaction evidence remains applicable.
  The web build passed; no full test/typecheck/lint suites were rerun for this two-declaration change.
- Evidence: `output/playwright/palette-groups/before-{desktop-light,narrow-dark}.png`,
  `after-{desktop-light,narrow-dark}.png`, `after-sessions-light.png`, `visual-check.log`,
  `keyboard-check.log` and `build.log`.
  Browser assets are rebuilt. No real user sessions/configuration were touched; temporary mock/browser
  resources are stopped and removed. The normal persistent execution session is retained.

## Session-row overflow — withdrawn

The user rejected hiding frequent Pin/Hide actions behind an ellipsis menu. Restored the pre-experiment
row implementation, navigation styles and direct-action tests; removed the menu component and its
menu-specific tests. Narrow/touch rows expose Pin/Unpin and Hide directly, and Hidden retains direct
Restore/Delete. Desktop hover/focus controls, ages, status, grouping and existing deletion protection
remain unchanged.

The independent Pending action-order repair at `1013f42` is retained: Copy, Return, Clear.
Other accepted frontend slices remain. Product code, styles and tests match `1013f42`; the restored
11-case navigation suite and web build passed. The normal persistent execution session is retained.

## Quiet secondary buttons — accepted and preserved

Implemented from clean `f06da23`; accepted at `a5ad7e7` when the user requested the next batch.
Preserves its shared action-button model and the accepted baseline.
Only `src/styles/foundation.css` changes product code: existing `.button--quiet` controls now have
transparent enabled resting fills/borders, retain body-color labels and inherit existing dimensions.
Hover/press use shared inset/control surfaces without a visible border; shared focus and disabled
states remain. History Back, pagination, recovery and Fork/Clone, the earlier-branch Clone, and
Terminal's Retry same operation share this finish. No modifier usages, handlers or action ordering
change. Terminal's empty-state New terminal remains primary, not quiet.

- Inspected real mock UI before/after captures at 1280×900 light and 390×900 dark. History list/detail
  and the earlier-branch banner lose repeated boxes without fading labels. Current-session actions
  and Terminal's primary New terminal retain their fills. Terminal recovery was exposed by aborting
  a browser-intercepted creation request before it reached the mock Host; no shell was created.
- Focused Chromium CLI checks confirm pagination, keyboard Back/focus restoration, Tab to Clone with
  the shared 2px outline, unchanged text/geometry, disabled hover, enabled hover/press and Terminal
  recovery styling. Existing History Fork/Clone and Terminal operation lifecycle evidence remains
  applicable; no full suites or theme matrices were repeated. A CSS-enabled Biome lint and web build
  passed. The build retains its existing large-chunk warning.
- Evidence: `output/playwright/quiet-buttons/` contains `{before,after}-history-list-desktop-light.png`,
  `{before,after}-history-detail-{desktop-light,narrow-dark}.png`,
  `{before,after}-banner-{desktop-light,narrow-dark}.png`,
  `{before,after}-terminal-retry-desktop-light.png`, hover/focus captures, `interaction-check.log`,
  `css-lint.log`, `build.log` and `visual-check.log`. Browser assets are rebuilt. Only isolated mock
  state and browser resources were used; no real sessions/preferences or user Host were changed.
  Temporary resources are stopped and removed; the normal persistent execution session is retained.

## History configuration order — accepted and preserved

Implemented at `d712e24`; accepted when the user requested the next batch. Based on `a5ad7e7`
in the main worktree. Pre-existing independent edits in
`activity-cards.css`, `composer.css` and `transcript.css` were left untouched.

- Only the same-session JSX order changes: Carry branch summary and its optional instructions now
  precede Edit in this session / Continue here. Existing spacing, typography, button roles, labels,
  bounded bottom dock and separate New session Fork/Clone group remain. No CSS changes were needed.
  Native skip/leaf conditions, blocked reasons, instruction state/limit and callbacks are unchanged.
- Strengthened the existing summary/Edit regression with checked and unchecked DOM order and
  same-session-only configuration assertions, while retaining its summary flag/instruction checks.
  The History component/controller/store suites passed (49 cases); changed-file Biome lint/format,
  TypeScript checking and the web build passed. The existing large-chunk build warning remains.
- Inspected before/after Chromium captures with checked and unchecked instructions at 1280×900,
  390×844 and 320×568 in Amber light. The compact configuration leads into its action without adding
  visual weight; the lower Fork/Clone group remains distinct. At short/narrow height, the existing
  dock scrolls, rather than expanding over the reading body. Tab reveals the complete focused action,
  including the wrapped Clone, and the instructions field fits at the dock's top.
- Browser checks confirm checkbox → optional instructions → Edit → Fork → Clone, stable dock bottom,
  retained instructions, unchanged reading scroll when toggling, and Back search/focus restoration.
  A separate Continue check confirms instructions → Continue order, summary flag/instructions,
  pending status and Stop summary dispatch, then cancelled-detail/configuration retention.
  Navigate, Pending recovery and abort were fulfilled entirely by browser routes, not sent to a Host.
- Evidence: `output/playwright/history-config/` holds
  `{before,after}-{desktop,narrow,short-narrow}-{unchecked,checked}.png`,
  `after-short-narrow-actions.png`, `after-summary-pending.png`, component/static/build logs,
  `browser-check.log`, `summary-cancel-check.log`, `visual-check.log` and `execution.log`.
  Browser assets are rebuilt. No real sessions/preferences or user Host were changed.
  This slice's mock processes, private fixture state and browser resources are stopped and removed;
  the shared browser workspace remains available to another active mock. The normal persistent
  execution session is retained.

## Welcome location hierarchy — visual experiment withdrawn

The user preferred the original layout and explicitly restored it. The bordered, filled directory
control is an editable path input, not redundant framing. Its location below the toolbar keeps the
first message visually primary. The directory-first order, underline-only field and added hero gap
from `bcb846c` are withdrawn; no directory-before-model ordering is a requirement.

Only the independent Enter repair remains: editing the directory cannot implicitly create a session;
IME confirmation and the first-message send shortcut keep their native behavior. The existing
regression now tests focus and Enter ownership without requiring the rejected visual order.
Welcome's stylesheet and visual DOM match `d712e24`; existing before captures under
`output/playwright/welcome-location/` represent the retained appearance, while after captures record
the withdrawn experiment. The 11-case start-surface suite, changed-file lint and rebuilt web assets
passed; restored results are in `restored-component.log` and `restored-build.log`. Earlier model,
attachment and browser-flow evidence remains applicable. Other accepted frontend slices and
the independent content-action presentation batch are retained.

## Content action presentation — ready for review

Implemented against the retained action styles after the user's per-scenario decisions.
Product changes are confined to `activity-cards.css`, `transcript.css` and `composer.css`;
the independent History and Welcome slices remain intact.

- CodeMode header Copy now reuses ordinary Tool/Thinking reveal behavior, including nested activity
  headers. Displayed custom-message Copy reveals within its header; extension text-widget Copy
  reveals within its whole widget. Pointer idle opacity is 0 and activation opacity is 1.
- Branch/compaction Copy now responds only to its disclosure header or independently focusable Copy
  control, not an expanded body. Native disclosure and Copy remain separate actions while collapsed.
- Assistant-response footer Copy retains emphasized presentation with desktop idle opacity adjusted
  from 0.48 to 0.50. All Pending Copy, Return and Clear actions stay visible and inherit the panel's
  existing 0.75-to-1 emphasis, without individual opacity layers. Panel surfaces, confirmation and
  Copy/Return/Clear order remain unchanged.
- User-message Copy/Fork already share reveal behavior and remain unchanged. System information,
  code-block and direct Shell-result Copy remain constant, as do path and Terminal text-reader
  controls. No-hover reveal defaults and the existing response-footer touch default remain 0.75.
  Content capability, clipboard payloads, layout and operation guards are unchanged.
- Chromium CLI checks passed for idle/hover/focus states, title-only versus body activation, collapsed
  summary Tab/Enter copying without disclosure, custom/widget clipboard payloads, Pending effective
  opacity and confirmation cancellation. Desktop light and 390px touch dark captures were inspected;
  the touch view has no horizontal overflow. CSS lint completed with specificity warnings; the focused
  style-contract suite and web build passed. The existing large-chunk build warning remains.
- Evidence is in `output/playwright/action-presentation/`: `after-desktop-light.png`,
  `after-activity-{idle,hover}-light.png`, `after-pending-{idle,hover}-light.png`,
  `after-touch-dark.png`, `after-{activity,pending}-touch-dark.png`, and browser/CSS/style/build logs.
  Verification used an isolated mock Host; no user Host, real sessions or user preferences changed.
  Browser assets are rebuilt. Temporary mock/browser resources are stopped and private fixture state
  is removed; the normal persistent execution session remains available.

## Topbar location glyph — withdrawn

The user rejected the added folder glyph. Restore the project name/path's plain-text presentation,
original spacing and copy feedback; remove glyph-specific CSS and assertions. Git's existing icon
and all other frontend slices remain. The independent project-path test initialization stays:
it selects its own session instead of depending on previous test state. Before captures under
`output/playwright/topbar-location/` show the restored appearance; after captures document the
withdrawn experiment.

## Files / Changes source canvas — ready for review

Implemented from `cb3efdb` after the approved Changes-reader proposal and the user's instruction to
identify shared Files/Changes design. Both use the same unframed source canvas and full available
width; rendered previews and status views retain their outer spacing. Files already had a sticky
line-number gutter. Changes now groups old/new numbers and the sign in a sticky gutter, with opaque
matching diff tints and retained active-edge feedback. Highlighting, text selection, change
navigation, source line jumps and index/detail allocation are unchanged.

The 23 relevant reader component cases, the existing style contract, TypeScript and repository lint
passed. Chromium captures and desktop/narrow checks cover the shared canvas, horizontal gutter
position, matching diff backgrounds, active-change navigation, selection without gutter text, and
retained rendered-HTML padding. Evidence: `output/playwright/source-readers/`, including
`files-after-light.png`, `changes-after-light.png`, `changes-scrolled-{light,dark}.png`,
`{files,changes}-narrow-dark.png`, `desktop-check.log`, `narrow-check.log` and component/static/build
logs. Browser assets are rebuilt; verification uses only isolated mock state. The previous
`changes-readability` captures retain the pre-slice card framing for comparison.

## Files file-type icons — ready for review

Implemented from `68d1168` after approval. Recent and the shared workspace file row now use
`fileIconForPath`, the existing Changes mapping. Recent prefers the resolved workspace path, then
the display filename, which already strips reference line/fragment suffixes. The common row covers
Files tree/search and the lower-left explorer. Directory icons, 13px sizing, decorative accessibility,
Git decoration, labels, layout and file operations remain unchanged.

The 30 existing mapping/Files cases pass, with icon assertions added to the existing browse/search
case. TypeScript, changed-file Biome and the web build pass. One isolated Chromium check covers
Recent, code/document/image/audio/video search rows, tree image categories and unchanged folders;
light/dark captures live in `output/playwright/files-type-icons/`. Existing Changes icon evidence
is reused. Browser assets are rebuilt.

## Search directory captions — accepted and preserved

Implemented from `9aba88a` after approval. Files search results display only the parent directory
under the filename, reusing Recent's parent-path extraction. Both hover titles retain the full file
path; accessibility names, open targets, matching and row heights remain unchanged. Root-level
results have no second line. The lower-left explorer only renders the shared tree, not search
results, and therefore needs no visual change; Changes also has no duplicated filename to remove.

The 18 Files cases pass, extending the existing search case to assert directory-only text,
full-path titles and opening. TypeScript, changed-file Biome and the web build pass.
One isolated Chromium run checks the same 11 results before/after, identical row heights,
full-path hover titles, root-file captions and opening, plus dark/narrow captures.
Evidence in `output/playwright/search-directories/`: `{before,after}-detail.png` and
`{before,after}-panel.png` are matched at the same viewport/scroll; `after-check.log` records
the measurements. Browser assets are rebuilt.

## Workspace search clear control — ready for review

Implemented after approval from `fe1e33c`. Only `.workspace-search input` suppresses the
WebKit-native search cancel button, retaining the existing themed clear button. The other four
`type="search"` inputs have no duplicate clear action and remain unchanged; transcript Close
is a separate action. No input handlers, layout or loading states changed.

The web build passes. An isolated Chromium check confirms identical before/after input geometry,
custom-button clearing, Escape clearing and the session search's native cancel still working.
Matched light crops plus dark/narrow captures are in `output/playwright/search-clear/`.
No new tests or fixtures are needed for this scoped CSS change. Browser assets are rebuilt.
The user accepted the preceding directory-caption slice.

## File search match emphasis — ready for review

Implemented from `42e894b` after approval. Only search result filename/directory text emphasizes
matching ranges at weight 600; it inherits existing text/Git colors and adds no background.
The full-path lowercase/whitespace-term matching mirrors Host search, then projects ranges into
the two display fields. Repeated/overlapping matches merge, and case-fold expansions retain original
character offsets. Resource labels retain their leaf-preserving elision and bidi isolation.
Recent, trees, Changes, titles, open targets, search ordering and matching remain unchanged.

The 24 focused Files/match cases, TypeScript, changed-file Biome and web build pass.
An isolated Chromium check compares the same multi-term results before/after, verifies equal
row heights/colors, weight 600, transparent matches, Git foreground inheritance, path-spanning
queries and no emphasis after clearing. Light before/after and dark/narrow captures are in
`output/playwright/search-matches/`, with measurements in `after.log`. Browser assets are rebuilt.

## History search match emphasis — ready for review

Implemented from `4325edf` after approval. History result snippets reuse the shared text-range
renderer at weight 600 with inherited foreground and no background. The helper now accepts explicit
terms/case folding: Files retains independent whitespace terms; History retains its whole trimmed,
locale-case-insensitive literal phrase. The shared class is now `search-match`, with separate
Files/History scoped styles. Roles, snippet text/clamp, search order, preview, outline and branch
actions remain unchanged.

The 43 focused History/Files/matcher cases, TypeScript and web build pass. Chromium compares 100
same results before/after with equal text/heights, weight 600 and unchanged colors; uppercase phrase
matching, preview/Back state, no outline emphasis and Files multi-term regression checks pass.
Light before/after plus dark/narrow evidence lives in `output/playwright/history-matches/`.
Browser assets are rebuilt. The user requested moderately larger topic-based batches going forward.

## Project-file picker presentation — ready for review

Implemented from `530ab1c` after approval as a consistency follow-up to the file-icon,
directory-caption and match-emphasis slices. The shared Composer/Welcome picker now uses the
same 13px file-type icons, parent-only captions and literal-term emphasis. Filename idle weight
is 500 and matches are 600; full paths stay in titles/accessibility labels. The new `picker--files`
scope preserves other picker styles. Single-line layout, panel sizing, results/order, selected rows
and keyboard/add behavior remain unchanged; long names elide within the available width.
Inline caret completion and referenced-file chips are not changed.

The five focused picker cases, TypeScript, changed-file Biome and web build pass. An isolated
Chromium comparison confirms identical result order, 420px width and 34.125px row height.
Keyboard adding, selected-row disabling, input focus and Escape return pass. Welcome root files
omit captions; narrow long-name simulation stays within the popup. Matched before/after plus
dark/narrow evidence is in `output/playwright/picker-file-presentation/`. Browser assets are rebuilt.

## Inline completion presentation — ready for review

Implemented from `d621d4d` after approval as one related batch. Composer and Welcome share the
same input menu: inline `@` results now reuse file-type icons, parent-only captions and literal-term
emphasis, with full paths in titles/option labels. Slash command titles separate the command name
from native argument hints (muted, weight 400). Descriptions, source grouping, ordering,
argument candidates, replacements and virtual-list mechanics are unchanged.
Desktop columns and narrow stacking remain; explicit baseline alignment prevents the icon/caption
markup from increasing row height.

The ten focused caret-completion cases plus Welcome's native-command case, TypeScript, changed-file
Biome and web build pass. Chromium compares identical file ordering/heights and all 25 command
texts/order/heights, verifies file insertion, Tab command completion, path-spanning emphasis and
Welcome root-file captions. Matched files/commands before/after plus dark/narrow captures are in
`output/playwright/completion-presentation/`; `after.log` records measurements. Browser assets
are rebuilt. No auxiliary Pi execution session was created for this batch.

## Shared model-list identity and match presentation — ready for review

Implemented from `5fa79bb` after approval as one batch across Composer/Welcome pickers and
Settings Models. Provider-group captions no longer repeat the provider; Common captions retain
it. Settings shows exact name/ID duplicates (including missing-name fallbacks) once, while distinct
IDs and full-identity tooltips remain. After review, picker identity deduplication is withdrawn:
Composer/Welcome keep the second-line ID and Common provider/ID, including identical names/IDs. Visible names, IDs and provider labels reuse match text spans,
projecting locale-folded literal/greedy-subsequence offsets from the unchanged model search text.
The existing filter/ranking, provider/Common groups, Router/Recent/No thinking marks and controls
are unchanged; model rows remain 48px in the matched Chromium fixture.

The 47 focused selector, Settings and match-renderer cases, TypeScript, lint and web build pass.
Chromium compares identical orders/heights in both empty and searched lists, checks shared
identity/fuzzy emphasis, native checkbox/radio types and keyboard selection, and captures light,
dark and narrow layouts. Before/after evidence is in `output/playwright/model-list-presentation/`.
Browser assets are rebuilt. No auxiliary Pi execution session was created. Selector and Settings
regressions (34 cases), TypeScript and the web build also pass after restoring picker captions.
The `after-picker*` captures predate this review correction; Settings captures remain applicable.

## Built-in dialog hierarchy — ready for review

Approved as a related batch from `a05a8fc`. The read-only path fill removal was subsequently
superseded by the requested editable path below; root shortcuts reuse quiet resting/hover/pressed surfaces while keeping
their compact dimensions and typography. Cancel in directory, export, individual-delete and
Clear Hidden dialogs uses the existing quiet modifier. Lists, frame geometry, primary/danger
actions, messages, Welcome's editable path and all operation/focus behavior remain unchanged.

The 17 focused directory/export/deletion-recovery/style cases, changed-file Biome, TypeScript
and web build pass. Chromium compares identical dialog, Cancel, primary and two-root shortcut
dimensions, checks transparent resting surfaces, root hover/focus and keyboard cancellation,
and reviews light/dark/narrow captures in `output/playwright/dialog-hierarchy/`.
Confirmation images compare the original and quiet Cancel classes in the same stable overlay.
No destructive action was executed.
Browser assets are rebuilt; no auxiliary Pi execution session was created.

## Editable directory-picker path — ready for review

Requested after dialog review. The picker replaces its read-only path with a real input matching
Welcome's canvas fill, line border, radius, mono typography and inset accent focus. Enter browses
without picking; confirming an edited path validates it with the Host and selects its normalized
result, not the old listing. Invalid paths remain editable and recover on editing/retry. Loading
makes the input read-only without losing focus; existing request ownership rejects stale/dismissed
results. Root shortcuts, folder browsing and hidden-folder behavior remain.

All 13 directory-picker cases, changed-file Biome, TypeScript and the web build pass. Chromium
compares computed input surface roles against Welcome, exercises Enter, invalid-path recovery
and direct typed confirmation, and checks dark/narrow layouts. Evidence:
`output/playwright/directory-input/`. Browser assets are rebuilt.

No other button styles changed in the directory follow-up. The subsequently approved
project-wide quiet-button trial is recorded below.

The approved wrapping follow-up uses a one-row textarea and hidden CSS sizing copy: short paths
remain one line, long paths soft-wrap, and height follows content and viewport width without a
manual resize handle or text scrollbar. Fill, border, focus, Enter navigation and typed confirmation
are retained; Welcome stays single-line. All 13 directory cases, changed-file Biome, TypeScript and
web build pass. Chromium measures one-line shrink, two-line desktop/four-line narrow growth with
no clipped text, then verifies Enter does not insert a newline and direct typed selection still works.
Updated light/narrow-dark evidence is in `output/playwright/directory-wrap/`.

## Window controls overlay — withdrawn

The user chose to remove the titlebar-fusion experiment after trying 32px and 40px rows.
The manifest, styles and tests are restored to ordinary standalone PWA behavior; neutral browser
chrome remains unchanged. Titlebar fusion is not pending implementation or review.

## Project-wide quiet buttons — ready for review

The user approved trying quiet buttons wherever appropriate across the project, with consistent
semantics. Presentation follows operation role rather than button text: subordinate Cancel/Back,
completed-login Dismiss and content loading/preview recovery now share quiet styling. This covers
model/provider edits and removal confirmations, extension select/input/editor requests, restart
confirmation, both Command Palette editing flows, History/Files/Changes and deferred-view recovery,
Command Help, provider/model loading and Terminal Host-settings loading. Host status rechecking
also uses quiet; restarting again, pending Cancel login and actual Pi Yes/No answers remain ordinary.
Primary/preferred actions and icon/selection/copy controls are unchanged. Deletion confirmation's
Cancel remains quiet, now aligned with other pre-execution confirmation exits. [[design-system]]
holds the role allocation.

All 97 relevant component/CSS cases, changed-file Biome, TypeScript and the web build pass.
Semantic regressions cover pending Cancel login versus finished Dismiss and Pi No versus input
Cancel. Chromium checks matched provider-form and palette-rename captures, dark/narrow form
presentation, editor cancellation and Back focus restoration; Back retains 63×44px geometry.
Computed-style checks confirm compact resource recovery retains transparent resting/hover borders
and standard hover fill. Evidence: `output/playwright/quiet-actions/`. Browser assets are rebuilt;
visual acceptance is pending.

## Model-list group and metadata hierarchy — ready for review

The user approved a visual trial of lighter group headings and auxiliary labels. Composer/Welcome's
shared picker loses the full-width heading fill but retains a thin bottom rule to distinguish groups.
The initial dark-only stronger rule is superseded by the shared neutral-stroke correction below;
provider headings now use the visible ordinary stroke in both luminosities. Settings' already-transparent
headings are unchanged. Shared Recent/Router/No thinking labels lose their filled background and
use normal-weight muted text; Settings shares the Router change. Identity, ordering, matching,
selection and Common/Default controls are unchanged.

All 35 relevant model component/CSS tests and the web build pass. Chromium compares the same
model data using restored baseline CSS for before captures, verifies unchanged heading/model heights
(28/48px) and row contents in picker and Settings, and exercises search/keyboard selection. Light,
dark and narrow-dark captures are in `output/playwright/model-list-hierarchy/`. Browser assets are
rebuilt; this trial awaits visual review. [[design-system]] records the presentation contract.

## Touch search-surface focus — complete

The user reported that opening model selection and the Command Palette immediately raised the
mobile software keyboard. ModelList, Command Palette and the matching project-file picker now
share device-aware initial focus: primary touch/no-hover opens on the non-editable list/panel;
desktop search remains focused. The palette modal also explicitly owns panel focus on touch so
its initial focus trap never focuses search first. Rename and prepared-command editing retain
intentional text focus. Result updates and viewport resizing preserve manually entered search.
The existing Composer touch-key policy shares the same device predicate without changing behavior.

77 relevant component/keyboard/modal tests, type checking, lint and the web build pass. Regression
cases cover opt-in search, absence of even transient palette search focus, mobile rename/back,
model selection/trigger restoration and project-file result updates. Chromium desktop and mobile
contexts (`isMobile`/`hasTouch`) verify initial focus, explicit filtering in all three surfaces,
and focus retention after viewport shrink. [[design-system]] records the shared contract.

## Shared neutral stroke colors — complete

The user approved unifying palette values and stroke roles across the project. `--line` and
`--line-strong` are the canonical ordinary/emphasized colors; the hairline names are single aliases.
Removed the overwritten 1px definitions. Dark ordinary strokes now differ from raised surfaces
(Amber `#303742`, Jade `#303A34`), fixing default internal divisions in searchable overlays,
command help and Terminal menus without per-component patches. Light ordinary colors are unchanged;
Jade strong hairlines now follow its own palette in both luminosities. Model headings use the shared
ordinary rule. Widths, surfaces, semantic accents, layout and Pending fading are unchanged.

The CSS contracts and web build pass. Chromium verifies both alias mappings in all four
palette/luminosity combinations and compares model menus, unfocused palette search, Settings,
tool cards and Pending at matched sizes/content. Before views restore only the baseline stroke
CSS. Narrow picker rendering and Pending hover recovery (0.75 → 1 → 0.75) pass. Captures are in
`output/playwright/line-tokens/`; [[design-system]] records the shared roles.

## Search feedback, palette boundaries and transcript information

The user approved session/Command Palette match emphasis, then added thin palette category boundaries,
unbounded CodeMode call-list height and clearer compaction information. Visible search hits use weight 600;
filtering/ranking and existing curation, hints and selection remain unchanged. Palette headings stay transparent
with shared ordinary bottom rules at their original height. CodeMode call lists use conversation scrolling;
individual detail/output viewports and ordinary nested lists retain their existing bounds.

Compaction cards distinguish Pi pre-context estimates from Magic Context historian-chunk estimates using
public entry source metadata, with known-prefix compatibility for already-loaded source-less snapshots.
Magic Context body display omits its repeated marker prefix; recorded text/copy and Pi context remain intact.

131 relevant tests, type checking and lint pass; the frontend is rebuilt. Chromium compares identical session results and palette options
using the retained pre-change frontend build: order, session-row heights, heading heights and narrow palette
row heights match. A 40-call CodeMode fixture grows from a 180px inner viewport to its full 1120px content.
Light/dark palette, 390px context labels, and keyboard execution of Settings pass. Captures are in
`output/playwright/navigation-search/`. Rules are in [[design-system]], [[tool-presentations]] and [[conversation]].

## Terminal navigator presentation slice

The user approved refining the All terminals menu: shared search-hit emphasis, original-case lighter
project names, and flexible secondary command hints. Implemented without changing the existing
case-insensitive substring filter, catalog order, status dots, Current marker or switching behavior.
Long command hints now use an available-width track rather than a fixed 72px cap; names keep the larger
share. Existing separators and compact rows remain. Desktop/touch row heights remain 30px/44px.

35 focused terminal and shared match tests, type checking, formatting and lint pass; the frontend is
rebuilt. Chromium review covers the same three-project/five-terminal catalog before and after, light
and dark themes, 390px/320px layouts, clear/filter behavior and keyboard switching to another project.
Visual comparisons are in `output/playwright/terminal-menu/`. Ready for user visual review.

## Shared native-choice skin slice

The user approved bringing History Carry branch summary, Export HTML/JSONL and model/provider declaration
checkboxes into the accepted Models Common/Default visual language. The existing Models skin is now an
opt-in shared `choice-input` stylesheet; all these inputs use it without changing native input types,
labels, grouping, handlers or layout containers. Models keeps its whole-label focus and disabled fading.
Other controls receive one input outline/fade. Switches remain unchanged. The user subsequently approved the same skin for Markdown task markers
across conversation, file previews and Notebook readers. RichText now supplies the shared class while
keeping them disabled; document CSS retains 13px geometry, original baseline alignment and normal opacity.

43 focused component/style tests, type checking, lint and the frontend build pass. Chromium checks cover
light/dark, narrow History, Space activation, forced-colors native recovery, and Models whole-label
focus/disabled behavior without duplicate rings or fading. Before/after screenshots are in
`output/playwright/choice-inputs/`. The base batch was accepted. The Markdown follow-up passes 54
renderer/document/worker/style tests plus type checking and lint; Chromium confirms checked/unchecked,
13px size, normal opacity, dark-theme paint and native forced-colors recovery in the Markdown file
reader. A subsequent user review caught a checked-state baseline error: inline-grid used its check
pseudo-element baseline, shifting checked boxes 4px down and increasing line height. Task markers now
initially used middle alignment, which equalized states but left a subpixel shift from the original.
The final skin uses inline-block inputs with absolutely centered marks, restoring the original task
baseline offset. Chromium confirms task box/text rectangles and line heights equal to native original
geometry, and zero changed pixels for the accepted form-control skin in representative Models layouts.
A stylesheet regression contract covers this alignment; 40 focused renderer/style tests pass. Follow-up images are in `output/playwright/markdown-choices/` and ready for visual review.

## Provider connection-directory slice

The user approved regular-weight provider names with semibold search matches in Connect provider,
plus a secondary monospace ID only when the ID matches but the name does not. The shared literal
match renderer supplies emphasis. Styling is scoped to the directory; connected-provider and
method-page titles retain their original weight. Filtering, order, controls, credential status and
authentication lifecycle are unchanged.

50 focused authentication/model-settings/match-renderer tests, type checking, scoped lint and formatting,
and the frontend build pass. Chromium before/after checks cover no query, name matches and ID-only
matches, dark and 390px layouts without horizontal overflow, keyboard Set up, method-title weight,
query/focus restoration and no authorization starts. Images are in `output/playwright/provider-directory/`.
Ready for user visual review.

## Next actions

Review the Provider connection-directory presentation. The Welcome and topbar-glyph visual experiments
are withdrawn. Group related refinements by topic rather than individual micro-adjustments;
propose the next batch's full scope and await approval before implementing it. Straightforward image copying and reverse-input ordering when copying multiple
images separately remain independent, unimplemented capability directions.

Preserve direct session curation,
accepted palette headings, narrow Thinking adjacency, filled red Stop, attachment/Pending hierarchy,
Terminal, main Settings and Models controls; do not reintroduce rejected reading, activity, Files
layout or session-row overflow changes.

Use an independent `gpt-6.1-sol` / high Pi implementation session when delegating, as requested.
Keep auxiliary sessions persistent and user-visible during work; clean them up when their tasks
finish. On 2026-10-09, the user requested cleanup and the 12 completed assistant-created execution
sessions were deleted through the Host into desktop Trash. The two user-facing frontend sessions
remain; code, documents and visual evidence are retained.
