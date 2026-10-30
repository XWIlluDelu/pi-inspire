---
scope:
  - src/**
  - tests/browser/**
  - docdoki/specs/design-system.md
  - docdoki/specs/interface-preferences.md
  - docdoki/specs/resource-preview.md
  - docdoki/specs/workspace-layout.md
  - docdoki/specs/composer.md
---

# Workbench interactions

## Objective

Keep conversation reading, resource inspection and settings controls consistent across desktop
and narrow layouts. [[design-system]], [[interface-preferences]], [[session-persistence]] and
[[resource-preview]] own the implemented contracts.

## Implemented decisions

- Desktop conversation search stays visible at the upper right. Ctrl/Cmd+F focuses it;
  Escape blurs without clearing the query. Narrow layouts retain the mobile search launcher.
- Changes uses an inline diff on narrow screens. Its filename filters and session search share
  compact search controls with a named clear action that restores input focus.
- Refreshing Files or Changes preserves the current rows and reader. Success, validation and
  loading feedback stay with the initiating control; retained warnings remain in the notice stack.
- Rounded containers, buttons and fields use the selected smaller radii. Files/Changes use
  understated underlined labels without changing selection or pane height.
- Existing structural type sizes remain unchanged. Additional pane borders were declined.
  Keep the previous uncluttered layout rather than reopening those alternatives.
- Shared error text uses semantic, palette-specific ink with readable dark-mode contrast.
  Installed titlebar dimming follows application overlays, without forcing Android system-bar
  colors or changing scrim scope.

## Verification boundary

Automated checks cover shared search controls, narrow inline diffs, transient feedback, titlebar
blending, palette contrast and desktop/touch search. Device-owned Android window chrome still
requires physical-device acceptance; [[follow-runtime-quality-2026-10-25]] tracks it.

## Right-pane tabs

The right pane gives opened files filename tabs and keeps Files/Changes/History/Terminal
as fixed trailing icon tabs sharing one content area. The file browser remains on the right; there
is no extra left tree, Files split or nested Files history level. Composer attachments share the
existing text/model-label inset. Following the user's correction, navigation retains its previous
460px manual maximum. The right pane may use the remaining shared width budget rather than a
fixed 920px ceiling; default widths and the conversation reserve remain unchanged.

Browser interaction checks confirm independent scroll positions for two files, retained Files query,
terminal output and unfinished input across tab switches and the shared width budget at 1280px.
A separate rendered-message check covers long URLs, tables, code, images and
formulas at 1920, 1280, 980, 390 and 320px, with local scrolling for wide blocks and no document
overflow. These reading checks
do not claim retained iframe-internal or video playback state; leaving interactive HTML still
retires its capability and requires explicit re-enabling. Focused checks passed: 127 resource/app
tests, 74 terminal tests, three pane-resize tests and 58 Chromium browser cases, plus the content
geometry scenario. Web typechecking, changed TypeScript formatting/lint and import boundaries pass.
Browser checks exposed and corrected clipped file-tab focus/close controls at 320px; refresh tests
now establish actual scroll range and fresh fixture discovery, and header measurements wait for
Git content before reading parent/child geometry together. The active filename tab remains visible
when the strip narrows. No assertion was relaxed for a failure.

The corrected right-pane width passes the three existing Chromium resize cases and the rendered-content
scenario: at 1920px the context pane reaches 1236px while navigation remains 272px and the conversation
retains 400px; at 1280/980px it yields to 648/348px. The 390/320px drawers and conversation remain
contained. Full project typechecking and import boundaries also pass. The user approved auto-dev
publication and deployment after these checks; main and the existing release tag are outside scope.

## Context tabs and page-reload continuity

The user approved the visual trial on `2031a483`. Tool tabs use
the shared 4px control radius: neutral hover, a theme-tinted selected background with accent ink
and the existing 2px indicator, and a slightly deeper selected hover. Close and refresh remain
neutral actions. Keyboard focus stays inside each control. The 1×16px refresh separator uses
`--hairline-strong`, matching the existing model-group vertical divider rather than adding a color.
Chrome pointer/keyboard checks cover these states in light/dark themes and confirm containment at
390/320px. Follow-up feedback tightens the desktop header from 44px to 40px and the narrow header
to 41px. The underline no longer displaces file controls above the tool icons; file and close SVGs
share size and center, selected ink is consistent, and labels reuse the existing optical-offset
token. Pi error Show/Hide details uses that same label correction without changing other icons.

The subsequent screenshot feedback removes the floating file-tab treatment: filename tabs now
fill the header's content height and begin flush at its left edge, with internal text/icon padding.
The close button is transparent in default, hover and focus states; hover changes icon ink and
keyboard focus retains a 1px outline. The selected tab keeps one continuous background and underline.
Chrome verifies 18 selected/unselected, title/close hover, focus and light/dark/narrow states;
file tabs fill the 40px desktop or 41px narrow header. No global button fill overrides them.
The following visual refinement removes the header's full-width gray rule, using the existing warm
background and each view's own local boundaries. Twenty Chrome combinations cover file preview,
Files, Changes, History and Terminal in light/dark themes at desktop and narrow widths; selected
orange indicators, transparent close controls and containment remain intact.

F5 restores browser-tab-local workbench metadata under browser-origin/session/workspace identity: current
session, pane visibility, file order/selection, tool choice, Files filters/expansions and independent
file reading positions. Widths reuse the existing persistence. Files are reauthorized and reread;
missing files keep their tabs and errors. Closing the pane retires content while preserving its
selection. No file body or HTML execution grant is persisted. Existing terminal reconnection retains
the shell and never replays commands. Transcript-position embedded images, iframe-internal scroll,
media playback and a specific Changes comparison are outside this reload restoration.

Ctrl/Meta+click in Files or a filename tab shows the authorized file or directory in the Host's
file manager. Linux FileManager1, Finder and Windows Shell requests use parameterized arguments;
unsupported/headless/native failure is reported. Linux browser Ctrl+click for a file, filename tab
and directory passes through the actual authenticated Host endpoint and acknowledged FileManager1
calls; ordinary preview and folder expansion remain unchanged. macOS/Windows native desktop
invocation remains untested on this Linux host.

Chrome validates source offset 780 and rendered offset 600 across F5, closed-pane reopening,
file order, navigation collapse, Files query, History selection and session isolation. Terminal F5
reconnects the same terminal ID, restores its output, and a fixture counter confirms the test command
runs once. A mock Host restart also restores the selected file and its 400px source offset;
the fixture now matches production's read-only saved-session admission rather than returning an
unrelated not-open conflict. The final targeted run passes 207 tests in 12 files. Typechecking,
changed TypeScript formatting/lint, import boundaries and the production build pass. No full
platform matrix is required for this iteration.

The startup follow-up keeps the create-session screen hidden while bootstrap or launch-continuation
is pending. Eight regression cases cover delayed restoration, empty and deleted selections, failed
reads/retry and an explicit new-session choice; the related targeted run passes 35 tests. Real Chrome
reloads, including a deliberately held bootstrap response, never insert the Welcome form and restore
the saved session without a timer.

Short inline math exposed a separate shared-renderer defect: KaTeX's zero-width layout helper
overhangs by about 2px (a 32px expression measured 34px scroll width), producing false scrollbars in
the inline-flex wrapper and clipping tall fractions. Natural inline layout removes that wrapper's
scrolling. Two Chrome regressions cover message surfaces and Markdown files, table/list formulas,
400px chat after right-pane resizing, and 390/320px viewports. Short display math measures 400/400px;
long display math measures 400/774px with working local scrolling and no page-width expansion.

The subsequent focused review found two confirmed boundary errors. During transport replacement,
resource and workspace controllers cleared navigation along with content authority; a tool gesture
could then persist the temporary empty tabs before bootstrap restored them. The controllers now keep
named tabs, selection and directory navigation while cancelling reads and revoking preview bytes/URLs.
Positional embedded-image references still retire. Targeted reconnect, retry, session-switch and
resource tests pass 94 cases, including old-content revocation and explicit navigation during recovery.

RichText also generated file buttons or image links inside authored Markdown links, causing inner
actions to replace the author's destination. Existing link context now keeps those labels inert while
the outer link owns navigation. Standalone references retain their original behavior; 74 rich-text and
document-preview tests pass, including the five cases that failed before this correction.
On the staged production bundle, Chrome verifies two automatic reconnects with bootstrap held:
tabs remain, old content retires, tool/query choices survive, and the unchanged file is reauthorized.
Chat and file-preview clicks retain exact authored destinations/fragments; standalone references and
the document-image inspector remain functional. Typechecking, changed-file Biome checks, import
boundaries and the production build pass. These frontend-only changes use atomic asset publication
with the outgoing asset generation retained; Host and terminal restarts are unnecessary.

The right frame now aliases its contextual background to the existing rail token, matching the
unchanged navigation and installed titlebar. Only its desktop top corners become square; bottom
corners and neutral file canvases/input surfaces retain their roles. Chrome checks file preview and
all four tool views in light/dark themes plus narrow containment. Twenty-seven existing style/palette
checks and the production build pass. Full-page fixture screenshots use the existing titlebar media
and geometry emulation; they do not claim a native installed-window acceptance run.

The following layout correction removes the desktop Changes preview allocation while no file is
selected. Its list keeps the full available height; selection returns the existing Source layout,
without an added empty-state hint or automatic selection. The mounted detail preserves existing
return-to-list focus and reading behavior. Files aligns search/section gutters and the Recent,
root-file and folder icon/name columns while retaining directory indentation and ordering; search
result icons center vertically. Sixteen targeted checks, typechecking and the production bundle
pass; isolated Chrome covers long-list scrolling, selection/refresh/return, light/dark themes and
390px containment. This change does not alter resource authorization or reconnect controllers.

A production-page follow-up caught a missed transition: after opening a file, closing/reopening
the pane or reloading while in Changes retained its reference but retired its preview. Treating the
reference as an active Source reopened the empty split. Changes now requires an actual resource
preview (including loading/error) or a Git comparison selection; remembered tabs alone do not
allocate Source space. The regression fixture retains that navigation metadata explicitly, while
filesystem/Git-evidence checks use a real pending resource preview.

## One file tab for body and Git inspection

The latest approved design supersedes the Changes split above. Changes is now a full-height list;
selecting a path opens/reuses its ordinary file tab in Git Changes mode. Files selects body mode
on that same tab. Side selection, line counts and bounded previous/next change navigation belong to
the file toolbar; Source/Preview applies within body mode and Download stays at the trailing edge.
The removed split component, secondary narrow Back level and their unused styles are retired.

The two sidebars retain their established shared rail color and functional widths. Following the
user's preference for the earlier unobtrusive design, both resize indicators are hidden at rest;
hover/focus reveals a 2px neutral rule and dragging uses the accent state. This supersedes the
resting 1px rule introduced with the file-tab work; the existing 8px hit band remains available.
The existing 12px content gutter and same-level file columns remain. A measured
320px reader initially squeezed its path to 26px; readers up to 520px now use a path row and action
row in both modes, restoring 296px for that path without moving the trailing Download action.

Targeted verification covers deleted/opaque paths without granting body access, staged/working
selection, known-path alias deduplication, session/transport ownership, late status after pane close,
and independent body/diff reading positions. Browser acceptance caught a real null-to-resolved Git
identity transition that reset saved scroll on tab return; stable file identity now preserves it,
while path and side still guard delayed jumps. The failing desktop/touch cases pass after that fix.
The affected browser set has 25 passing cases across its initial pass and targeted rerun; 123 unit
checks passed before the final additional restoration regression, whose 19-case component suite
also passes. Typechecking, scoped lint, import boundaries and the staged production build pass.
Actual Chrome checks confirm F5 restores [800,50] reading offsets, frame-stable tab/header heights
and Download position during mode changes, mouse/keyboard resizing, and light/dark containment down
to 320px. Mode-specific controls intentionally appear/disappear; no further unexplained vertical
jitter was reproduced. Screenshots use only the isolated fixture, not live user contents.

## Optional Carbon & Silicon palette

Carbon & Silicon adds a neutral Light/Dark surface family to the existing palette preference,
Settings swatches, command palette and before-paint cache. It preserves the default
Chimonanthus choice and all legacy palette migrations. The Modern theme references
and upstream MIT notice ship with the static assets. No typography or layout changes
accompany this option. Error, warning, success and Git states remain colored; scoped
code-leaf tokens retain Chimonanthus syntax colors without a new code-theme system.

Focused preference/API, theme bootstrap, palette UI and color-role checks pass,
along with TypeScript, scoped lint and Host import preflight. Carbon & Silicon text and solid
actions meet 4.5:1 contrast on their declared surfaces, and focus meets 3:1.
The initial addition required an idle Host restart because its palette enum is
captured by Host validation at startup. The later Carbon & Silicon display-name change keeps
the shipped `mono` identifier and makes the last picker choice span a complete row;
that change needs only static publication, with no preference migration or restart.

Isolated Chromium acceptance confirms successful Carbon & Silicon preference writes, Light/Dark
page-reload restoration, switching back to an existing palette, and readable complete
palette names at 390px and 320px without document overflow. Keyboard focus retains its
2px outline. Rendered colored syntax tokens in chat, Source and a real file diff match
Chimonanthus in each luminosity; ordinary source text follows Carbon & Silicon's neutral body ink.
Full-page Light/Dark screenshots were reviewed using mock content only.

## Complete-interface visual review

Two browser review passes cover chat and expanded activity, Composer and attachments, navigation,
Files/Changes/History/Terminal and file modes, the welcome page, Settings categories and menus at
desktop and 390/320px widths. Carbon & Silicon Light/Dark and representative Chimonanthus views keep
their existing type and spacing hierarchy. Logo comparisons use painted bounds; text controls are
also checked against rendered letterforms rather than assuming their boxes share optical centers.

The confirmed remaining layout residue was Files Recent reserving five rows even with only one
reference. It now uses its actual content height, reclaiming 116px in the one-row case without
changing the five-row case or the section gap. Empty, loading and retained-error states preserve
their existing behavior. Unused measurements from the former split index are removed.

Related browser checks now match the accepted full-height tabs and restored open panes after F5
and recovery. Same-font comparisons of the complete nine-dot pattern at -1, -0.5 and 0px, both lit
and partially lit, favor the half-pixel optical correction without changing colors. Marks retain
their bound against the label's actual ink center. Responsive measurements wait for the desktop pane owner after a
viewport change instead of sampling across drawer restoration. These changes preserve coordinate
precision rather than adding arbitrary delays or weakening interaction checks. Physical-device
font rasterization and every provider authentication step are outside this browser review.

The 62 relevant Chromium scenarios pass across the main run and focused Activity/extension reruns,
together with project typechecking, scoped lint and the isolated production-mode build. The
extension fixture now restores its own browser selection after API creation, matching the existing
live-event fixture rather than relying on the Host's process-global selected session.

## Independent design finish

An independent screenshot critique followed the geometric review, focusing on reading hierarchy,
surface density and useful space rather than treating absence of overflow as visual quality.
Result tables now use their own 12.5/14/15.5px tier instead of the smaller metadata tier. The idle
topbar returns unused status width to the session identity while keeping trailing actions fixed;
nonempty status and inline rename retain their established budgets.

Behavior's reorder list removes repeated ordinary row borders, leaving its container and the
meaningful More actions boundary. The directory visibility action follows the trailing content
edge. On coarse pointers, file close areas are 32px wide and reader actions are 32px tall; the
narrow reader spends existing vertical padding on those targets and stays 57px high. Icons,
action order, transparent close treatment and desktop density remain unchanged.

The quiet home lockup, Composer writing space and long-activity boundaries remain intentional.
Prompt Map keeps its real reading gutter, and mobile editable paths retain their 16px input size;
reducing those solely for visual uniformity would trade away navigation or input usability.

## Visible disclosure edges

A user-supplied enlarged phone screenshot exposed a missed distinction: matching the Activity
button to the prose container did not match its visible chevron. The 4px control inset and
Lucide's intrinsic side whitespace accumulated into an 8.7px painted indent. Both chevron
directions now balance against letter ink with a shared 7px hanging row; the padded focus/hit
surface remains, and open guides, nested tool headers, title-aligned details and context events
follow the same corrected hierarchy. The nine-dot vertical correction and colors are unchanged.

Matched before/actual-build after screenshots were visually inspected at 1440, 390 and 320px
in Carbon & Silicon Light/Dark, with a Chimonanthus sample. Chinese prose, collapsed/expanded
groups, expanded Thinking and compaction checkpoints were included. Independent screenshot
reviews of the four right-side tools, file headers, running Terminal, Settings, reorder menu and
confirmation dialogs found no further worthwhile correction. Folder depth and subordinate
History Activity remain intentional. Provider/model disclosure internals could not be reviewed
because the isolated fixture exposes only their unavailable state; physical-phone rasterization
remains outside this browser review.

All eight focused Activity/context Chromium scenarios pass, including keyboard/touch/copy,
deferred-prefix expansion and nested-call states. The regression now measures the actual SVG
path/stroke against letter ink; a former container-edge assertion is removed while title/detail
alignment stays enforced. Typechecking, scoped formatting and the production-mode build pass.

## Compact session navigation and contextual toolbar

The 2026-10-29 user-approved adjustments were visually reviewed, followed by explicit approval
to commit to auto-dev and publish the static build. Desktop navigation defaults to 220–240px rather than
220–272px without migrating a saved width. Its session title owns the first line, with the
existing age/project/activity metadata and trailing hover/focus actions below it. Ordinary
pointer rows are 44px; coarse desktop rows are 52px with visible 36px actions. Narrow session
markup and geometry remain unchanged. The context tool header is 36px desktop / 37px narrow,
retaining 16px icons, the centered refresh separator and at least 32px coarse/narrow targets.

Focused verification covers 16 Chromium scenarios and 24 navigation/resize unit cases, plus
type checking, scoped Biome checks and an isolated production build. Real before/after pages
use the same synthetic Chinese conversation at 1600×1000. Phone title, metadata, action and row
rectangles match the prior build exactly; a saved 360px width survives reload. The coarse
desktop check caught and corrected an inherited static action row; its actions remain positioned
inside the second line. Publication uses the existing atomic static-build workflow without a Host restart;
main and existing tags remain unchanged.

The follow-up local refinement reserves a 12px status slot before the title so age keeps the
title's start even when status changes; cross-project labels follow age. Hidden's independent
rows retain a shallower indent than folder children while clearing the selection marker.
A focused rendered review of Files/Changes/History/Terminal found one shared-control mismatch:
History search now matches Files at 34px high, 13px icon, 12px inner inset and 8px gap, with a
4px top inset. Content typography and terminal/code font roles remain unchanged. This follow-up
uses targeted visual/interaction checks, type checking and an isolated build, not a repeated matrix.

The subsequent approved refinement puts session status beside the first-line title rather than
second-line age. It uses the folder's 16px icon slot and 8px text gap with the existing 12px glyph;
title and age axes remain unchanged when status disappears. Hidden and folder children keep their
existing hierarchy and selection-marker clearance; the rules remain desktop-only.
The rendered hover review also aligns desktop row surfaces to New/Search's 12px outer inset
instead of the list's prior 8px, offsetting inner padding so icon/text axes do not move. Files
retains its correct leading icon columns and directory depth; availability warnings now use a
nonshrinking trailing 16px slot. Stacked search/list padding before Recent drops from 20px to 8px,
without flattening the heading or Recent-to-workspace section rhythm.
The approved Hidden follow-up removes its extra whole-folder indentation on desktop: project
icons and content surfaces now follow normal projects, while the actual folder/session grouping
and independently hidden root sessions remain intact.
Focused final-build inspection confirms 12px shared surface insets, 24px icon centers and 40px
title/age axes, including selected Hidden rows. Short/long missing-file warnings keep 12px glyphs
in 16px slots at a 320px Files width; compact mobile rows retain their existing inline layout.
Type checking, scoped Biome and the isolated build pass. No broad suite was repeated for these
visual refinements. The user explicitly approved auto-dev publication without a screenshot approval
gate; the existing atomic static-build flow avoids a Host restart and preserves live work.

## Initial connection indicator placement

The Android loading screenshot exposed a pre-existing baseline fallback and duplicate feedback:
without a session title, the topbar connection glyph appeared at the row's top while the central
workspace loader already explained startup. The approved simplification omits the ordinary topbar
transport hint only while that central loading state is visible, including startup session recovery.
Failures retain their existing warning/retry paths; session reconnect feedback remains available.
The no-identity centering correction remains useful for Welcome's later connection states, while
selected-session text baselines and shared loading-glyph geometry remain unchanged. This correction
is included in that approved release. Six focused Chromium cases pass for initial loading, startup failure
and retry, Welcome/session reconnect and existing title baselines. Type checking, scoped Biome
checks and the isolated production build also pass.

## Floating file actions and confirmation text

The approved file-preview change permanently removes its path/header row. A compact action group
floats at the content's top-right with the existing Git/body toggle, applicable change count and
previous/next controls, icon-only Copy path and trailing Download. Copy reuses owned clipboard
feedback; the full path remains in its accessible name/tooltip and copied value. A small top inset
keeps the scrolling content viewport below the controls instead of hiding text underneath them.
Narrow and coarse targets remain 32px; global file/tool tabs are unchanged.

Delete confirmation changes only description padding: its text now starts with the session name
inside the inset label, while icon/title hierarchy and trailing actions remain distinct. Before/after
rendered measurements agree exactly after the correction. Both modal checks were cancelled, with
DELETE requests blocked and none attempted.

Twenty-one related unit cases, two existing fine/coarse focus scenarios, type checking and the
isolated build pass. Actual previews cover Markdown/Source, 320px static HTML, two-change navigation,
Copy path, mock download and Dark appearance. The user approved committing both completed batches
to auto-dev and publishing the static build, without changing main/tags or restarting Host.

## Floating-toolbar follow-up and Hidden hierarchy

User feedback confirmed that the previous content inset still looked like an unused header. The
reader now uses its original top padding; the tools overlay it and collapse on direct reading input,
with an explicit expand/collapse entry and Escape focus return. Programmatic diff navigation and
reading restoration keep the tools expanded. Core action order starts with Source/Preview, then
Git, change navigation/count, Copy path and Download. Source is directly available from Git even
before its body has been read, while known unavailable source stays disabled. The compact `1/3`
count reserves digits for its total; horizontal group padding is balanced.

Hidden root projects and standalone sessions retain their shared axes and full-width interaction
surfaces. The attempted extra 20px project-child indent was rejected after rendered review and
reverted to the prior compact desktop layout; existing folder grouping remains. Desktop status glyphs
right-align within the existing 16px folder slot, adding 2px selected-marker clearance without
moving titles or the row boundaries. Mobile layout remains unchanged. The auxiliary user-message
bubble inspection changed no CSS: equal 10px vertical padding gives a small 1–1.5 screenshot-pixel
ink-center difference, insufficient evidence for a fixed offset.

Thirty-one focused source/diff unit cases, type checking and the isolated build pass. Actual
desktop/320px checks cover direct Git→Source, tab reuse, compact count navigation, reclaimed
space, keyboard/read collapse and mixed Hidden hierarchy. Publication uses the authorized auto-dev
static workflow; main and existing tags remain unchanged.

## Activity density and quiet session selection

The approved Activity density follow-up keeps all font sizes and reading line heights. On
fine-pointer desktop, item headers shrink from 30px to 28px and adjacent Activity/checkpoint
groups use an 8px gap (the actual transcript wrapper previously used 16px, distinct from the
12px paragraph-content gap). Normal prose/prompt boundaries and narrow/coarse targets stay
unchanged. Ordinary and virtual-list content spacing were checked in the isolated rendered build.
Session opening now stays quiet for 800ms, then uses plain `Opening…` age-slot text rather than
the agent-running glyph. The existing focused indicator scenario covers pending, delayed feedback,
completion and real activity states. Files' visibility button drops an obsolete -2px right margin;
its 28px hover target now shares the refresh target's right edge without resizing either control.

## Screenshot-led navigation detail review

The subsequent screenshot-led detail review preserves Activity's Rajdhani face and the existing
font sizes, reading width and row geometry. The selected session's text block and marker are
visually centered; its trailing actions intentionally align with the metadata line. Actual keyboard
inspection found the folder action focus ring clipped by 2px above/below the 28px heading, so the
actions now use the same inset focus offset as the folder toggle. Opening rows also keep full
label opacity while pending instead of flashing to 55%; the 800ms text feedback and all pending
safety guards remain. No typography/layout redesign accompanies these corrections.

## Smaller sidebar status marks

The approved sidebar status-size follow-up renders running/completed/failed glyphs at 10px rather
than 12px, retaining the original layout box and 16px desktop slot. Scaling uses the mark's
13.8/16 painted right edge and vertical centre rather than the SVG viewport centre. In the focused
desktop fixture the painted right stays at x30.35, title at x40 and row height at 44px; the marker
clearance grows from 5.15px to 6.6px. Activity matrices, global loaders, the selection marker and
the separate attention dot remain unchanged.

## Scoped Copilot spacing comparison

The follow-up compares the actual Copilot reference with the same synthetic Inspire conversation
and projects before/after at 1920×1080; screenshot pixels are not treated as reference CSS or font
identity. The bounded review covers session title/date rhythm, project gaps, icon/text gutters,
type hierarchy, both header/tool regions and Composer padding.
The 44px two-line rows (18/16px line boxes, 1px gap, 12.5/11.5px text) and 16px folder icon with
8px text gap remain. Existing right-side tools retain their 36px header, 12px trailing inset and
compact 24px file-action targets. Fine-pointer desktop ordinary project surface gaps shrink
18→14px; topbar utilities retain 28px targets but group gaps shrink 8→4px (100→92px total).
Composer horizontal padding shrinks 12→8px, keeping input/model/attachment axes together at
18px rather than 22px from the border; its 99px measured height, fonts and vertical rhythm remain.
An 8px setting-to-file-action gap distinguishes those groups while each group's internal gap
remains 4px. The extra group gap is absent in constrained two-row desktop and mobile layouts.
Hidden independently lists standalone sessions before project folders and preserves internal and
keyboard ordering; its boundary uses existing section spacing rather than extra indentation.

## Delete-confirmation text alignment

The screenshot-led confirmation review measures visible text rather than assuming centred line
boxes. Plex title ink sat about 1.33px above the badge and close glyphs; the existing 1px optical
text offset reduces that difference to about 0.33px. The session label and explanation already
share their body reading column (individual letter side bearings differ by about 1px), and footer
icon/label centres differ by about 0.36px, so those layers are retained. Dialog wording and delete
behavior are unchanged; isolated confirmation checks block DELETE and only dismiss the dialog.

## Right-pane surface hierarchy

The right header retains the rail background and uses one weak 1px hairline against the content.
Files, Changes and History use the main stage surface; file previews use the same canvas while
their controls and authored/terminal content retain separate roles. Selected tabs share that
content surface and keep their accent underline. Focused checks cover all four tools in Carbon &
Silicon and Jade light/dark, plus an opened Markdown file; the header remains 36px and resize
dividers remain invisible at rest. Left navigation geometry and colors are unchanged.

## Shared terminal tabs and floating controls

Project terminal tabs now render beside file tabs through the existing terminal component, keeping
its catalog, selection, process attachment and control ownership. Opening the shared strip reads
the catalog even from Files; only the active terminal surface polls. The fixed Terminal icon
creates one default-profile terminal. Terminal controls float in the output's top-right with
explicit collapse, Escape and input/reading-intent collapse. Search temporarily owns that corner;
background output does not open or close the controls. Focused windows retain their own tabs.
Shared rename inputs use the same label origin and optical text offset as their tab labels.

Verification: 55 terminal component cases and 37 resource/action cases pass; focused Chromium
lifecycle, menu/focus and active-view controls scenarios pass. Isolated native terminals preserve
output across file/two-terminal switches and refresh from Files. Default creation and close/Reopen
counts match requested actions; busy-close cancellation sends no removal. The narrow view keeps
output at the pane top without a reserved second header and no viewport overflow. No user terminal
or in-flight task is used by these checks.

## Collapsed tools and right-panel edge

Collapsed file and terminal tool groups reduce horizontal padding from 6px to 2px, matching the
existing vertical padding without shrinking their icon-button hit areas. Desktop terminal controls
become 34px square and file controls 30px square; expanded spacing remains unchanged. A weak 1px
right-panel leading border distinguishes its stage-colored content from the conversation. The 4px
gutter, 8px resize hit band and hidden-at-rest drag indicator remain unchanged; no header line changes.
Terminal status dots retain 6px paint inside the file icon's 13px slot, so equal labels occupy equal
tab widths. Shared padding, close slots, natural sizing and the 180px cap remain; rename inputs
follow the same label origin.

## Selected-tab frames and deferred header

Selected file/terminal tabs now have weak non-sizing top/right edges and cover the bottom hairline
to join their content; inactive tabs remain unboxed. The deferred right-pane shell no longer
renders its legacy visible Context title before the real tabs mount. Header geometry, Close,
normal loading and actionable errors remain; the toolbar's content Refresh never used this shell.

## Terminal overlay ownership and explicit collapse

Terminal clicks, selection, scrolling and typing now preserve the user's tool-group state;
Hide/Show and toolbar Escape remain explicit collapse controls. Selection Copy/Add actions and
copy confirmations temporarily share the same corner ownership as Search, restoring the previous
tool state afterward. File-preview reading-intent collapse is unchanged.

## Floating tool sizing and corrected panel edges

File and terminal floating tools share 24px desktop / 32px touch/narrow buttons, 14px glyphs and
the same padding/gaps. Reserved terminal status/focus and search slots prevent mount/connection
state from changing the group's size. Normal Controlling text is removed; ownership, connection,
read-only and Take control behavior remain. The right gutter is 8px whitespace without a permanent
panel border. Selected tabs use top/left/right hairlines and 4px top corners, open at the bottom.

## Source icon and shared tab widths

Source/Preview uses CodeXml/FileText icon actions with the same accessible names and tooltips;
the user's follow-up replaced the initial Eye choice with a document preview glyph.
File and terminal floating buttons increase together to 28px desktop with 16px glyphs, retaining
32px touch/narrow targets and the existing gaps, padding and collapse behavior. File and terminal
tabs share a 132px minimum and 180px maximum (bounded by the strip), keeping close actions aligned
and long names ellipsized. Panel gutter, selected-tab borders and top corners are unchanged.

## Shared tab overflow

File and portalled terminal tabs now share one measured overflow policy. Excess tabs remain
mounted but move into More tabs, using the existing accessible Dropdown; selecting an entry
reveals it without reordering or recreating content. Resize and title/selection changes update the
visible subset, with the active tab reserved first and no horizontal scrollbar. The shared 132px
minimum remains intact, including the minimum desktop pane; extremely narrow drawers retain all
controls with a second row. Standalone/focused terminal windows keep their existing own strip.
Focused browser checks cover mixed file/terminal overflow, revealing hidden file and terminal
tabs, minimum-width and expanded-width resize, preserved order, and the 320px drawer layout.
The resource-preview toggle case, typecheck, lint and isolated build pass; no full CI matrix was run.

## Connected tool tabs and interaction icon

Fixed tool selection now uses the file tab's content-connected surface and fine top/side boundary
instead of an underline; Terminal remains New terminal. All file-tab hover surfaces retain 4px
top corners. Empty desktop strips reduce the necessary tool/header height from 36px to 32px without
adding filler; Files search keeps its existing 4px internal top inset and no additional reserved row.
HTML interaction uses ordinary/clicking pointer glyphs in the shared 28px desktop control, retaining
Enable/Stop accessible actions, pressed/busy state, execution grants and revocation. Five targeted
HTML tests pass; isolated visual checks verify actual selected/hover surfaces and both pointer
states. No broad CI matrix or production restart is needed.

Desktop conversation and the whole contextual pane use a subtle 1px theme hairline and 6px outer
corners; navigation remains part of the shell. The existing pane gaps and invisible resize handles
remain independent, and narrow/mobile views retain their previous edge-to-edge surfaces.
Desktop shell right and bottom padding are both 8px, aligning the conversation and context outer
bottom edges and preserving the right inset when context is closed. Content padding and
narrow/mobile layout stay unchanged.

## Right-pane chrome and grouping polish

The fine-pointer desktop header now stays 32px through loading, empty and populated states;
previously the first tab increased it to 36px, moving content and floating tools down 4px. Floating
tool groups keep 2px within groups and 6px between them. Terminal temporary search/selection
overlays now share the existing 8px top / 12px right tool anchor (previously 6px / 8px), retaining
their corner ownership and control-state behavior. Desktop HTML loses only the redundant 1px
inner viewport frame; its content inset and execution isolation remain. Secondary controls already
share 28px desktop targets, 16px glyphs and muted ink; status colors and font sizes retain their semantics.
Focused compiled-CSS checks confirm identical header/content/tool origins across HTML, Source and
terminal, 6px group boundaries, unchanged 28px/16px controls, and the common search overlay anchor.

## Context search and section spacing

The user's saved pre-change production baseline is
`c263c2ac829ac7fee3e78fcf8c3ce86fc6c260e1`; HTTP resources and the clean local HEAD matched before
this pass. Files/History search top insets are now 8px. Files removes double search-to-heading
padding (8px to 4px) and uses 24px headings instead of 30px, retaining its 28px Recent rows and 12px
section break. Changes heading ink starts at 12px instead of 16px, with the same 24px heading tier;
its list surface inset is 4px instead of 8px. History uses the same 4px surface inset instead of
12px and removes the first turn's extra top padding (first control gap 16px to 8px). Real compiled
CSS measurements verify these changes in the same isolated page. Terminal floating search already
has its own coherent 8px/12px anchor and compact controls, so no extra terminal change was made.

## Undecided interaction proposals

The following remain proposals, not implemented requirements:

- A command-palette entry that discovers existing actions without duplicating their policy.
- Discoverable keyboard access to thinking and slash-command choices, with IME-safe handling.
- Clearer attachment-upload progress that preserves durable retry and draft ownership.
- Visual differentiation of project groups.
- A quieter idle composer and less decorative chrome around short messages or reasoning blocks.

Review each against its actual workflow before implementation. Preserve action availability,
reading behavior and the user's accepted layout; wider terminal, MCP and settings work has no
additional acceptance requirement from these proposals.
