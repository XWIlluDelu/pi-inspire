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

The two sidebars retain their established shared rail color and functional widths. Both resize
boundaries use a 1px token-colored rule, a 2px hover/focus rule and an accent drag state, within the
existing 8px hit band. The existing 12px content gutter and same-level file columns remain. A measured
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
