---
purpose: Shared palette roles, typography, geometry, responsive workbench layout, and interaction motion.
covers:
  - index.html
  - public/favicon.svg
  - public/app-icon.svg
  - public/app-icon-maskable.svg
  - public/app-icon-192.png
  - public/app-icon-512.png
  - public/app-icon-maskable-512.png
  - public/apple-touch-icon.png
  - public/theme-init.js
  - src/styles.css
  - src/deferred-fonts.css
  - src/styles/*.css
  - src/assets/fonts/**
  - src/assets/licenses/**
  - scripts/render-app-icons.mjs
  - src/visual-preferences.ts
  - src/use-reading-dwell.ts
  - src/use-copied.ts
  - tests/web/content-copy.test.tsx
  - tests/web/{reading-dwell,notices,runtime-activity}.test.tsx
  - scripts/import-ibm-plex-sans-sc.mjs
  - scripts/verify-release-package.mjs
  - server/preferences.ts
  - shared/contracts.ts
  - src/**/*.tsx
  - tests/web/{styles-contract,palette-colors}.test.ts
  - tests/web/palette-css.ts
  - tests/web/app.test.tsx
  - tests/web/overlay-and-palette.test.tsx
  - tests/web/theme-init.test.ts
  - tests/browser/{shell-layout,settings-layout,reading-navigation,palette-preferences,theme-colors}.spec.ts
  - tests/browser/support/colors.ts
  - tests/browser/loading-states.spec.ts
  - tests/browser/icon-controls.spec.ts
---

# Design system

## Goal

Give INSΠRE a coherent, medium-density scientific-workbench character while keeping conversation
content dominant. This spec owns shared visual roles, identity-defining values and component anatomy;
behavioral contracts remain with the corresponding feature specs.

Labels and feedback describe the user's task and visible state, without exposing internal loading
paths or control flags.

## Identity and palette

### Identity assets

- **Visible lockup:** `INSΠRE`; **natural-language and accessible name:**
  `Inspire`; **technical identifiers:** existing `inspire` and `pi-inspire`
  names. The wordmark is IBM Plex Sans SC with a highlighted `Π`, not a second
  display family.
- The Open Reticle is the compact identifier: opposing square ink brackets,
  four detached accent datum ticks, and a centered square aperture. Its small
  and display masters compensate independently; the transparent 16px favicon
  is a pixel-fitted optical master.
- Installed PWA icons use a fixed, soft six-color mark on a porcelain-white tile,
  independent of the active UI palette. Jade `#419C9F` forms the upper-right
  bracket and Amber `#E58850` the lower-left. Clockwise from the top, the ticks
  are Wisteria `#9C84BB`, Chimonanthus `#D6A252`, Lycoris `#D17672`, and
  Hydrangea `#6BB08C`. These are optically tuned launcher colors, not live theme
  tokens. The centered carbon square is `#262A30`, 40×40 on the 512px master.
  The matte tile has a subtle white-to-cool-gray gradient
  (`#FFFFFF` → `#FCFCFD` → `#F0F1F4`) and a soft edge, without texture,
  gloss, or a baked-in outer shadow.
  Ordinary PWA icons scale the complete tile and mark to 81.25% of the canvas,
  leaving a 9.375% transparent inset on each side (48px on the 512px master).
  This keeps launcher size comparable to neighboring desktop icons. Maskable
  and Apple touch assets use an opaque, full-bleed porcelain master and rely
  on the operating system's own mask. Versioned icon URLs allow installed
  browsers to discover revised assets.
  The transparent browser-tab favicon is also palette-independent: it keeps its
  pixel geometry and ink/white brackets, with neutral quartz-gray `#63676C` ticks
  in light browser chrome and silver `#B9C0C7` ticks in dark browser chrome.
  It adds no background or opacity change. In-app identity retains its accents.

### Installed windows

Supporting installed desktop windows use Window Controls Overlay with `standalone` fallback.
Ordinary tabs, unsupported browsers and disabled Overlay reserve no custom row. The browser supplies
titlebar height and native controls; only its safe strip is draggable. Workbench content, dialogs,
drawers and focused terminals stay below it.

The uninterrupted strip uses `--bg-rail`, without subdivisions, bottom rule, gradient or shadow;
the navigation divider stops below it. Its `theme-color` follows palette and resolved luminosity
before first paint and after Host bootstrap, including system-theme and Overlay-mode changes.
Ordinary tabs and standalone fallback use neutral `#F4F5F6` / `#14171A` hints; the manifest keeps its
neutral light fallback. Browser/OS support determines native controls and installed-icon update timing.

A small INSΠRE wordmark centers over the whole window within the browser-reported safe rectangle,
independent of navigation resize/collapse. INS and RE use quartz-gray/silver, Π the brand accent,
with 180ms color transitions. A noninteractive 16px Open Reticle shares the collapsed rail's icon axis
when safe, otherwise sits 12px inside the safe rectangle's left edge, without a background. When
native controls leave insufficient width, the wordmark yields to this corner icon; its optional
needle toggle remains in Settings. Keyboard focus stays within the safe height, even in short titlebars.

Desktop Overlay navigation omits the duplicate brand and starts with New session beside Collapse,
then search; the collapsed rail uses a navigation icon. Ordinary tabs and narrow drawers retain
their sidebar brand/header. Browser-owned chrome details: [[workbench-implementation]].

#### Titlebar needles

The titlebar brand toggles an optional Buffon's needles animation, default off, with accessible
semantics, a tooltip and `app-region: no-drag`. It shares the persisted Settings → Display switch.
Needles arrive individually at independent random intervals. Each has a random static position and
orientation, independently sampled length/fade lifetime, and the live theme's `--activity-tool` or
`--activity-think` color.

For 2400 drawable CSS pixels, arrivals occur at 3.6 × (1 + busy session count) per second. Count all
managed and observed native Pi sessions once per identity, excluding waiting-for-input sessions.
Frequency scales with the full decorative titlebar width after a 2px edge inset. Sample uniformly
behind foreground controls, including the icon and wordmark, without control exclusion zones,
safe-rectangle clipping or opaque mark backplates. The layer receives no pointer events; native
chrome may paint above it.

Dimensions use CSS pixels; lifetime distributions stay the same across displays, and particle limits
scale with density. Resize and run-state changes retime future arrivals without clearing current fades.
Needles neither spin nor fall. Reduced motion, a hidden document, inactive Overlay or toggle-off
immediately suppresses/cleans up the animation.

#### Completion cue

An observed successful run in the selected session gives Π one 800ms glow. Snapshots, session switches,
failures and aborts do not trigger it; hidden pages never replay it on return. Reduced motion disables
both this glow and wordmark color transitions.

### Theme selection and semantic roles

- Palette and luminosity are independent. **Wisteria** (`wisteria`) uses mineral purple,
  **Hydrangea** (`hydrangea`) celadon green, **Lycoris** (`lycoris`) mineral coral,
  and **Chimonanthus** (`chimonanthus`) honey amber. **Jade** (`classic-jade`) and
  **Amber** (`classic-amber`) retain their classic teal and warm-orange identities
  and light/dark surface ladders. Chimonanthus remains the default.
  Light, Dark, and System select luminosity independently of the palette.
  Display presents six named color swatches; the selected choice has a border and pressed state,
  not color alone. The picker uses two columns and keeps complete names reachable on narrow screens.
- Saved `amber` migrates to `chimonanthus`; saved `teal` (formerly Jade) migrates to
  `hydrangea`. The Host accepts these legacy identifiers on read and API patches without
  treating them as invalid. Reads remain observational; the next successful preference write
  saves canonical identifiers. A browser-local visual cache applies the same migration before
  React starts, but Host preferences remain authoritative after bootstrap. The restored Jade
  and Amber choices use distinct canonical IDs, so selecting them persists independently without
  changing the interpretation of legacy saved `teal` or `amber` values.
- Semantic role mappings stay consistent across palettes while botanical and classic families
  retain their distinct character. Roles may share a color value.
- Decorative accents and readable ink are separate roles:

  | Palette | Light accent | Light accent ink | Dark accent | Dark accent ink |
  | --- | --- | --- | --- | --- |
  | Wisteria | `#6E5494` | `#543D78` | `#B39DDB` | `#C2B0E6` |
  | Hydrangea | `#1F7A68` | `#155B4D` | `#5EC4AE` | `#74D2BE` |
  | Lycoris | `#BC5042` | `#94362A` | `#EE8474` | `#F49B8E` |
  | Chimonanthus | `#B36010` | `#8A4605` | `#EAA03E` | `#F2B25C` |
  | Jade | `#007D78` | `#005E5A` | `#52D2C9` | `#52D2C9` |
  | Amber | `#D95A00` | `#A23E00` | `#FF781F` | `#FF781F` |

  | Role | Use |
  | --- | --- |
  | `--accent` / `--accent-deep` | Theme marks and running feedback / readable accent text. |
  | `--accent-fill` + `--on-accent` | Solid actions and checked switches: white foreground in light mode, dark foreground in dark mode. Hover/active fill roles darken light fills and lift dark fills; decorative accent variants are not assumed safe behind small text. |
  | `--on-status` | Foreground for semantic error fills, with the same luminosity-aware hover/active treatment. |
  | `--accent-focus` | Outlines, focused borders and inset focus strokes. Maps to `--accent` in botanical palettes and `--accent-deep` in Jade/Amber. Focus leaves text, semantic errors and other selection markers unchanged. |
  | `--nav-active-bg` | Selected-session `--accent-tint`; the extra `--accent-soft` inset outline is transparent. |

### Control states

| State | Shared presentation |
| --- | --- |
| Selected | Icon buttons retain accent ink/tint. Segments and named palette choices use `--accent-deep` text/icons with surface and weight cues. Hover, press and focus preserve these cues; arbitrary selected lists and semantic status indicators retain their own roles. |
| Disabled actions and segments | Neutral ink/fill, default cursor and no hover/pressed changes, including underlines or borders. Quiet controls remain transparent. Read-only headings retain readable text without action highlighting. |
| Disabled switches | Preserve checked/off state with reduced opacity. |
| Dropdown becomes disabled | Close its menu without changing the selected value. |

These rules apply across Settings, Terminal settings, Composer/prepared-prompt delivery choices,
resource modes and standalone actions. Solid controls retain their foreground/fill pair in every
enabled state; disabled styling takes precedence over local action styles.

### Surfaces and status

- Botanical surfaces carry the theme's paper temperature throughout the rail, prompt,
  activity, code and reading areas. Light stages are Wisteria `#FAF9FC`, Hydrangea
  `#FBFBF9`, Lycoris `#FCFBF9`, and Chimonanthus `#FCFBF8`; raised surfaces and
  Composer remain white. User prompts use the tinted rail family, not white cards.
  Dark stages use purple charcoal, green charcoal, warm red charcoal and warm amber
  charcoal respectively, with lighter surfaces and darker code/inset areas.
  Component structure stays independent of palette. Classic Jade and Amber retain their own
  accents and surface ladders.
  Resting navigation search uses `--bg-control`; the topbar blends 88% `--bg-stage` with
  `--bg-rail`. Components use shared roles rather than local palette values.
- File inspection is the deliberate exception: its host-owned Preview, Source,
  and Changes canvases use the luminosity-aware `--bg-file-*` neutral ladder,
  which is identical across all supported palettes. Product chrome remains
  palette-aware, rendered artifacts retain their authored backgrounds, and
  source syntax or Diff additions/deletions retain semantic color. Syntax and Git
  text use luminosity-aware colors with AA contrast on their neutral or tinted
  reading surfaces.
- Small status text uses `--success-ink`, `--warning-ink`, `--info-ink` or `--error-ink` on neutral
  and tinted surfaces. Outlined, quiet and menu danger actions and activity-fold loading failures
  retain `--error-ink` through hover, press and focus; danger borders/tints use `--error`.
  Successful command badges use `--activity-success-ink`. Status icons, borders and tints keep their semantic color. Text contrast,
  including faint text, holds on its actual surface in every interaction state.
- Tool and Thinking have distinct theme identities and matching tints; failure never recolors
  those identities. Context-event/extension glyphs and ongoing compaction use `--activity-event`,
  an alias of `--activity-tool`; compact progress text uses `--activity-event-ink` on its tint.
  Context and extension glyphs keep the unmixed identity color. Their attribution, surfaces and
  disclosures remain distinct from tool executions. Ordinary notices and command outcomes use
  information/success/warning/error roles, independent of activity identity.
- Error/Stop uses raspberry-red, distinct from Lycoris's decorative red. Light semantic ink is
  deeper than accent fills; dark semantic ink is lifted. Navigation combines color, positioned
  marks and accessible state: working uses Π in the warning role, completion uses success,
  failure uses error, and recovery has its own visible treatment. Color alone never carries state.

## Neutral stroke colors

- `--line` supplies ordinary structural dividers and resting boundaries. `--line-strong`
  supplies emphasized neutral edges, including stronger control boundaries and hover states.
  Stroke widths are separate. Classic Jade and Amber use ink-with-transparency strokes.
- `--hairline` and `--hairline-strong` alias those roles in every palette/luminosity combination.
- Botanical strokes follow their paper temperature: light Wisteria `#DAD6E4`,
  Hydrangea `#D6DDD4`, Lycoris `#E0D6D2`, Chimonanthus `#DFDAD0`, with individually
  tinted dark counterparts. `--line-subtle` aliases `--line`; `--line-strong` supplies
  stronger boundaries. Focus and semantic status retain their own roles.

## Type, geometry, and spatial hierarchy

| Font | Role |
| --- | --- |
| IBM Plex Sans SC | Interface controls, prose, Chinese/Latin flow and wordmark. |
| Flux Mono SC | Code, paths, identifiers, timestamps, shortcuts and machine data. |
| Rajdhani (`--font-label`) | Activity headers/boundaries, resource tabs, Settings section headings and model-list section labels; Sans SC handles other scripts. |
| Bundled KaTeX faces | Mathematical glyphs. |

Latin core faces load with the shell. The complete checksum-pinned CJK registry loads after
authoritative bootstrap, avoiding competition with first render while fetching only used Unicode
subsets. Rajdhani supplies local 500/600 faces; structural labels use 500, uppercase Latin and
restrained tracking, with 600 for selected resource tabs. Other navigation, file, palette and
completion/model-choice headings retain authored casing; technical identifiers retain exact spelling.

The type scale is 11.5, 12.5, 14, 15.5, 17, 21, 26 and 32px, with maximum weight 600. CJK running
text has no tracking; short uppercase Latin labels may use restrained tracking. Compact, Comfortable
and Large presets remap conversation prose, headings, code, reasoning, tables, drafts and text
previews; interface controls keep fixed tiers.

Resource tabs use four equal columns, 13px labels (12.5px untracked in the smallest groups), and
28px desktop / 34px compact-touch height with adjacent 32px actions. Complete labels fit without
cropping or distortion. Count capsules use `--accent-tint`/`--accent-deep`, smaller text on the label
baseline and a distinct gap. When a complete label/count pair cannot fit, omit the count while
retaining the exact Changes total in its title.

Activity disclosure marks and Settings icons align optically with uppercase letters. A wrapped
Settings title keeps its icon beside the first line, outside the font line box, and its action
independent of that group. Dialog titles, prose and deletion errors wrap long paths or identifiers
within their content edges. Settings status and Host availability explanations stay within their
text columns, preserving payload text, field widths and action geometry.

Shared geometry follows a 4px spacing scale: 2px inline corners, 6px controls, 10px resting surfaces
and 12px overlays. Fully round `999px` radii are for capsules, status geometry, scroll thumbs and
thin resize strokes. Inset menu highlights and compact file/search/terminal actions, including PDF Fit, use the
control radius; model-list highlight insets leave virtual-row heights unchanged. Nested radii account
for parent padding/borders; provider fills use outer radius minus border thickness. Focus follows the
control silhouette, including terminal tabs' rounded upper corners and square content join. Settings
and navigation selection markers are thin and round-ended.

Neutral surfaces, hairlines and whitespace express depth. Elevation combines contact and ambient
shadows: `--shadow-1` is faint and absent in dark mode; `--shadow-2` lifts menus/notices in light and
classic dark palettes, while botanical dark uses borders and surface contrast; `--shadow-overlay`
separates dialogs/drawers. Shadows supplement borders without adding an outline. Reading, navigation
and contextual shells have no elevation. Composer has no resting shadow and uses a crisp focus
boundary with a faint close ring alongside its independent state treatments.

[[workspace-layout]] owns pane geometry and resizing. Reading/Composer measures are Narrow 680px,
Comfortable 820px and Wide 980px, bounded by center-pane width. The 44px topbar aligns the regions.
Connecting/reconnecting uses a quiet, unboxed, accessibly named transport hint that disappears on
recovery; offline and Host failures retain warning treatment.

## Scrolling

Native scroll areas share a transparent track and a rounded, neutral thumb with stronger hover and
pressed states. Settings, pickers, History, Files/Changes, document previews and horizontal code
scrolling inherit this treatment. Chromium/WebKit use an 8px track with a 6px visible thumb and no
arrow buttons; Firefox uses its native thin geometry. High-contrast mode retains system colors.

Terminal's own slider uses the same color roles and visible thickness while retaining its drag target
and scroll handling. Navigation/conversation boundary rails and deliberately hidden tab-strip bars
keep their existing behavior. Embedded documents retain their own styles.

## Pane and navigation presentation

Pane states use an unfilled 36px icon slot, weight-500 title and secondary hint, retaining their
semantic roles and recovery actions. Compact directory messages keep their local layout. List/search
emptiness uses 24px 16px padding, a 4px gap and `--text-sm`; conversation emptiness uses 64px vertical
padding, an 8px gap and `--text-xl`. Empty-state titles, including Terminal, use weight 500.
Git change-group counts use secondary monospace text at weight 400 without capsules; status marks
and the repository summary keep their separate roles.

The navigation header pairs a noninteractive reticle/wordmark with the sidebar-outline Collapse
button. New session is a quiet full-width row above Search, with control-radius neutral hover and
no resting box, shadow, badge or header divider. New/Search share height, font size, a 16px icon slot
and baseline; New has slightly heavier text and a neutral plus. Their gap is 8px, followed by 16px
before projects, including in the Overlay header. The collapsed rail's mark expands navigation and
its separate plus starts New; both logo forms share size and icon axis.

New, Search, folder and session labels share a text axis; counts/ages share the right column.
Hidden folders add one indent, independent of workspace-tree nesting. Narrow/coarse-pointer
New/Search rows are 36px high with 14px labels; icon-only rail/close actions retain 44px targets.
WebKit uses 16px editing text to avoid focus zoom, retaining compact resting labels.

Session, conversation and workspace search use muted icons/placeholders and ink-colored input,
stronger hover icons and accent focus borders. Session search rests on an inset control surface with
a fine boundary that strengthens on hover and changes to surface fill on focus. Conversation/workspace search retain
opaque surface fills and fine resting borders.

Selected session rows have a translucent lifted surface; collapsed folders containing the selection
have a quiet accent tint. Both use an inset straight, round-ended accent marker, with neutral ordinary
hover. The row retains selection fill even when its select button is disabled. Folder rows/headings
use control-radius corners, a clear icon gutter beside the marker and a common text axis with their
sessions. Folder, Workspace and Hidden keyboard outlines remain inset within clipping boundaries.

Project spacing is 16px above the 2px catalog gap, and 20px after pinned sessions or the last pinned
folder; collapse preserves it. Hidden keeps its compact drawer spacing regardless of previous pinning.
Runtime status stays on each session's existing row rather than duplicating sessions in separate
status groups, preserving project hierarchy and user curation.

## Conversation surfaces

User messages are right-aligned, content-sized bubbles with 14px corners, a neutral border and no
accent edge. Copy/Fork fit to the bubble's left with an 8px gap and bottom-aligned targets; otherwise
they wrap below at the same right edge with a 4px gap. This content-driven rule covers text and
image-only bubbles without shrinking or rewrapping them; bubbles and attachments stay within the
reading width. Actions use centered 13px glyphs, 24px mouse
or 32px narrow/touch targets and a 4px inter-action gap. Visibility follows
[Action-button presentation](#action-button-presentation).

Assistant prose and expanded Thinking use open reading flow. Activity headers are transparent
disclosure rows; [[activity-presentation]] owns their guides, density and reading rhythm. Context
events share the leading disclosure axis and transcript-row gap, without extra outer inset. Titles
keep intrinsic width; adjacent metrics wrap to the title's text axis and share its baseline. Expanded
text uses the same anchor, while Copy centers independently of its hit target. Row hover strengthens
ink without a fill; keyboard focus uses a rounded outline.

Custom messages use a bordered `--bg-surface` without a colored edge, a package/type header, readable
Markdown and separately folded Details. Configured attribution and subdued source share a baseline;
header, body and Details share a reading anchor, with Copy in its own column. They inherit neither
tool status nor activity density. Pi errors use a compact neutral surface, subtle error border,
semantic label and readable reason, with bounded inset diagnostics.

Error, extension and shell headers fit touch Copy targets within their padding without enlarging the
text row. Shell sections own their inset without a second turn-layout gap. Pending Copy centers on
the first line while wrapped previews keep balanced vertical padding.

## Composer presentation

The Composer is one reading-width instrument: attachments/references above the writing field,
Steer/Queue in a dedicated delivery row, and a quiet metadata toolbar below. Its writing surface has
12px corners and a quiet border; spacing separates the rows without an internal divider. Attachment
corners use the control radius. Input text, the delivery row's outer edge and the model label share
one horizontal content anchor, including on phones, while selector hit areas retain their padding.

Toolbar order is Model, Thinking, project files and attachments, context usage, optional Stop, and
rightmost Send. Send is icon-only; Stop has a square glyph and filled error-color treatment, including
compaction and shell cancellation. DOM/tab order follows visual order. On phones, Model and Thinking
share the first row, with file tools, context and Send/Stop below. At widths up to 420px, selectors
remain adjacent with an 8px token gap: Thinking retains its full width and Model shrinks without
filling spare space. Long model labels truncate inside their trigger. Steer/Queue split their row
equally. Constrained desktop panes use the compact arrangement under [[workspace-layout]]. Completion
titles wrap without displacing adjacent path hints; model badges and selected rows retain AA contrast.

Running uses a close, low-opacity theme halo with a 3.6-second opacity cycle. It intercepts no pointer
input and changes neither geometry nor shadow properties; the normal border and independent focus
border remain. Reduced motion keeps a static low-intensity halo. Retry and Compaction use their own
static semantic halos; conflict recovery retains warning treatment. [[composer]] owns delivery state,
including when recovery is the sole action.

Command feedback uses neutral surfaces and semantic icons/text, without panel-wide status washes or
competing running glows. Failed receipts are unframed, wrapping inline feedback with a compact Dismiss
action; action-rich results may use local containers. Extension widgets have a small identity/Copy
header and readable preformatted content in Pi's above/below-editor placement. Extension questions
remain distinct attributed forms with directly selectable options.

## Feedback and notices

- Choose feedback by the user's task, not by the number of internal states. Where ordinary selections
  or saves need feedback, use the existing control's busy/disabled state. Do not append progress
  sentences or reserve empty rows for routine internal work. Keep useful option guidance visible while waiting.
  Distinguish internal request and execution phases only when that distinction changes the user's
  available action or understanding of the outcome.
- Retain usable content during background work. An empty initial view or a materially blocked task
  may need concise loading feedback; a populated picker, provider list or update result does not need
  a second progress announcement. Preserve actionable errors, consequential confirmations, genuine
  task progress and notices that a saved change needs a reload or restart.

- Session and usage use the shared Info command receipt: the information icon, command/INFO heading
  and subtle semantic tint remain consistent with other informational results. Only message count,
  total tokens, cost and context occupancy appear as compact inline label/value pairs, wrapping with
  the available width. Project, model, session name and raw JSONL path are omitted, without a
  secondary disclosure. There is no separate panel title, divider, metric grid, highlighted cost or
  duplicate progress bar. Long values remain readable. Repeating the query updates the same card
  in place without increasing dock height or restarting an entrance animation. The bounded,
  focusable dock retains keyboard/touch scrolling when distinct results need it; a single readout
  does not stack merely because it is queried again.
  When usage is unavailable, the result says so rather than rendering an empty Info receipt.
- Feedback expires by meaning and ordinary text volume, not by Info tint alone. Short INFO
  confirmations and bare Name normally have a 3-second reading dwell; one- or two-sentence guidance
  such as Quit has 5 seconds; denser INFO and the four-field Session & usage readout have 8 seconds.
  General notices use compact icon/message/action rows instead of repeating a visible severity
  heading. Severity remains announced and extension attribution stays in the message. Short messages
  size to their content within the stack's width; diagnostics wrap without losing Copy/dismiss.
  Those actions keep 24px mouse or 32px touch targets, aligned with the message's first line.
  Embedded resource errors and richer update cards retain their contextual presentation.
  Non-modal notices sit below active modal dialogs rather than covering their content or controls.
  Navigation and resource drawers also own modal interaction on narrow layouts: notices sit
  below the drawers and any scrim, retaining their contents and returning to the normal layer
  on dismissal.
  Bound the stack below the workspace header/current banners and above the bottom safe inset.
  Welcome and conversation views share one floating feedback owner and presentation; a page
  transition does not move notices into page flow or expand them to the start composer's width.
  Anchor notices at the top-right at every width, below the header and any overlapping transcript
  search or mobile tool row. Editor height does not move this anchor; its top edge only limits the
  scrollable stack when their horizontal ranges overlap. Follow toolbar, editor, banner and pane
  resizing. Empty space beside content-sized cards does not intercept input.
  Only an overflowing stack scrolls, without compressing cards or discarding diagnostic text;
  fitting stacks retain their normal width, shadows and placement. Additional notices preserve
  an existing reading position. Copy, dismiss and keyboard scrolling remain reachable.
  Exact repeated notices coalesce in place and renew their dwell. Hover, focus within, an active
  pointer press and a hidden document pause the clock. Reading time starts only when at least half
  of the card is in view and pauses when it scrolls out of that range; resuming keeps the remaining
  time with at least 3 seconds to finish reading. Expiry uses only a standard 150ms opacity fade, omitted
  for reduced motion. Manual dismissal remains immediate. Errors, warnings, export actions and
  update availability do not expire on these timers. State-owned progress, extension widgets and
  retained transcript content keep their own lifecycles. [[composer]] owns query/session boundaries
  and command outcome handling.
- Attachment file chips put filenames and state ahead of technical metadata. Pending's visual
  emphasis follows [Action-button presentation](#action-button-presentation); [[composer]] owns
  bounded summaries and action semantics.

## File and path labels

Workspace, Changes, project-file pickers, inline completion and uploaded/sent file tags share the
filename-based monochrome file-category icons; unknown types use a neutral document. Compact file
rows and completion use 13px icons. Image attachments retain their thumbnails. Pickers and search
results separate filename from parent directory, omit empty root-level captions, and retain the exact
path in titles and accessible names. Literal query-term emphasis uses weight 600, inherited ink and
no background; feature specs define matching and row layout.

Semantic path labels retain one exact value for assistive text, tooltip, Copy and navigation. A
fitting path stays complete; actual container overflow elides the parent before the filename, without
breakpoint or percentage quotas. Ordinary titles and bare filenames keep their own text treatment.

## Shared labels and controls

- Notebook execution prompts share one intrinsic gutter across cells and outputs. Retain the
  existing desktop/narrow minimums and first-source-line baseline; wider counts grow the shared
  gutter instead of painting over source. Unusually long prompts wrap within a bounded text width.
- Files, Changes, History, and Terminal share the contextual pane. Resource
  safety and change semantics belong to [[resource-preview]]; branch behavior
  belongs to [[session-branches]].
- Compact Plex labels share a 1px optical adjustment in buttons, segmented controls, dropdown
  values, section titles, and custom-message attribution. Button height and icon geometry stay
  unchanged; prose and mixed-font field descriptions retain their normal line boxes. Custom-message
  icons and Copy center against the attribution group, including when the sender wraps.
- Button sizing follows local visual balance, not a shared equal-width rule. Stateful actions
  reserve only their own relevant labels where feedback would otherwise disturb the action row;
  different actions and command delivery modes retain content-sized widths. MCP, provider and
  model forms use `Save` without repeating the configuration context; MCP uses `Saving…` while
  pending. Command preparation uses concise `Run` / `Send` labels, retaining `Steer Pi` / `Queue prompt`
  for busy-task delivery. It keeps the submitted action's label footprint while awaiting acceptance.
  Export stays a text action in both states, without inserting a new icon only while busy.
- Searchable menus use the same accent tint for pointer hover and keyboard candidates. Pointer
  movement and arrow navigation select one highlight mode; leaving a row removes its hover without
  dismissing the panel or blurring its search field. Checkmarks and `aria-selected` identify committed
  values independently of that candidate highlight. Settings model search stays neutral until keyboard
  navigation or an explicit row action.
- Command Palette uses a 580px desktop maximum width, bounded by the viewport. Search text,
  group titles and result titles share a 20px content edge; candidate highlights retain their own
  outer inset. Groups use compact overline headings and neutral bottom rules without full-width
  shaded bands, with tighter spacing between sections. Default groups distinguish `Actions`, `Workspace` and `Sessions`.
  Long titles use up to two lines; project/age metadata stays secondary and moves below titles on
  narrow screens. Omit redundant action descriptions without removing useful search aliases.
  The accent-tinted candidate remains the action highlight; shortcut hints stay separate.
## Overlays and deferred surfaces

Modal overlays use the shared radius, hairline, elevation, restrained scrim, 2px backdrop blur and
short 0.97→1 pop-in. [[interface-preferences]] owns modal focus, keyboard priority and extension-question
suspension. Anchored menus keep their trigger gap while accounting for overlay scroll, fixed-position
coordinates and reserved window chrome.

Settings and Terminal settings share a safe-area-aware narrow frame with fixed navigation/footer.
Narrow category selection uses an accent underline and keyboard outline, without card fill, border
or shadow. Update rows use the standard section/card geometry, with Pi, Extensions and INSΠRE; the
check action reserves its longest state label. Update checks use one `Checking…` button state from
request through completion, while the rows retain the last observed versions and available updates.

Deferred surfaces keep one interactive shell and focus owner through loading, ready and failure.
Loading visuals appear after 250ms, immediately under reduced motion, without delaying ready content
or errors. Settings skeletons preserve column, navigation, card and footer geometry but are excluded
from the accessibility tree and tab order. Context, History and Pi release notes share centered
status/recovery presentation: loading Π with concise status; failure alert with an unavailable title,
the actual error as a secondary hint and quiet Retry. State content owns its padding independently
of document/help content; it does not repeat the unavailable title as a hint.

## Settings forms, disclosures and configuration actions

Section headings and descriptions sit above independent bordered field cards, without tinted header
bands. General and Terminal settings share shell/content insets across viewport sizes; card-level
empty/error messages use the field rows' content inset. Asynchronous descriptions anchor at the top,
with actions before feedback; meaningful feedback remains readable in normal flow without reserving
blank space for routine progress. Cards and sections do not clip menus or focus. Checked switches use
the shared accent fill/foreground pair, and category/palette selection retains explicit markers.

Settings and Terminal settings share 32px mouse and 40px touch fields, switches, steppers and
segmented controls. Ordinary dropdowns, segments and the palette grid share a choice-column width.
Segments use a recessed group with a neutral selected surface and edge; named palettes use independent
bordered tiles with an accent-tinted selected surface and accent border. Both retain stronger selected
weight and theme-accent text. Palette names/hue markers stay visible; section icons use accent ink
and headings stay neutral.

Fields wrap controls according to available space and keep descriptions readable. Narrow cards let
wrapped controls fill the row; switches, font steppers and model summaries remain compact, and segment
labels never wrap. Neighboring segment rows stack alike in narrow Terminal cards. In narrow model
settings, group labels align with model names and empty default values use their text width instead
of reserving an absent dropdown's width. Herdr availability/restart notes are unboxed, with each
message and its associated action wrapping as separate items. Disabled controls remain legible and
distinct from available choices.

Local Settings disclosures use a thin leading chevron, consistent text spacing, native keyboard
activation and the shared rotation transition; each disclosure retains its own default open/closed state.

Configuration sections put their Add action beside the section title. Provider, declared-model and
MCP entry rows share quiet trailing Edit/Remove icons with accessible names and tooltips; confirmation
remains separate. Provider/model nesting and User/Project MCP grouping retain their distinct meaning.

## Native choice controls

Ordinary checkbox and radio inputs share a 14px skin: strong neutral borders and control surfaces
when unchecked, then accent tint with a check or dot when checked.
Checkboxes remain square and radios circular. Native inputs retain their labels, grouping, keyboard
operation and disabled semantics.

Keyboard focus uses the shared accent outline. Models owns focus and disabled fading on the whole
choice label, so its input has no second outline or opacity reduction. Other disabled choice inputs
use one opacity reduction. Forced-colors mode restores native appearance and removes the custom marker.
Settings switches keep their separate skin. Markdown task markers use the shared appearance at 13px,
with document margins and -0.15em vertical alignment. Check/dot markers center inside the input without
changing box position or line height. Recorded task states are noninteractive at opacity 1.

## Model-list hierarchy

The Composer model popover is capped at 384 × 456px, with viewport-aware placement. The shared
Thinking popover starts at 208px wide and uses 30px desktop option rows, retaining 44px touch rows.
Both pickers inset row highlights by 6px and keep a 12px text edge. Composed Thinking controls add
8px vertical padding around the status-bound choice group without changing the native option rhythm.
Its range input shows keyboard focus around the selected dot, not a clipped rectangle across the labels.
Their bounds reflect their different content densities while preserving text size and model identity.

The shared model picker uses transparent provider/group headings with a thin ordinary-stroke bottom
rule and a 28px virtual-row height. Long headings elide on one line; their title and accessible group
label retain the full provider name. Settings provider headings also use transparent surfaces with
their own typography. Recent, Router and No thinking labels use muted, normal-weight text without a
filled badge.

## Session and command search presentation

Native search-clear glyphs use the field's theme ink and a consistent cross; clear and Escape
semantics remain owned by each field. Workspace search keeps its explicit clear/loading control,
without a second native clear button.

Session titles and visible project names/context emphasize matching text at weight 600, without
changing colors, backgrounds, ellipsis or direct Pin/Hide controls. Visible token emphasis uses Pi's
greedy subsequence projection, including its letter/digit swap; phrase emphasis preserves native
whitespace normalization. Host result filtering remains under [[session-continuity]]. Regex queries
and matches confined to hidden fields have no browser-side visible emphasis.

Command Palette emphasizes visible title matches at weight 600 and secondary hint matches at
weight 500. Hints retain their secondary color, size and placement; aliases and cross-field matches
remain search inputs without invented visible matches. Transparent group headings use a `--line`
bottom rule that replaces one pixel of padding, preserving heading height and text position.

## Extension question choices

Immediate-submit choices distinguish current keyboard focus and pointer hover without a check
that implies an answer has already been submitted. Focus retains a visible accent outline;
hover and press use the raised neutral surface with a fine neutral inset boundary so they remain
distinct from the recessed list in light and dark themes. Choices support Click/Enter submission and
roving keyboard navigation.

## Compact menus

Dropdown options, session actions, Settings move options and terminal menus share a raised surface,
hairline border, medium radius, compact padding and entry motion.
Action rows use the same small UI text, accent-tint interaction feedback and inset focus role.
Each owner retains its action/selection semantics, anchor, grouping and viewport constraints;
searchable model lists and descriptive project groups keep their information hierarchy.
Session actions size to their content within viewport bounds, with drag handles in a separate
trailing column. [[workspace-layout]] owns compact disclosure and [[interface-preferences]] owns
saved ordering.

## Content copying

Copy availability follows the content, not a text-only projection. Image-only user messages and
image-bearing tool/custom content keep their established Copy action; the shared image viewer
also offers a constant Copy for an inspected saved or attached image. Its Copy, Download and Close
actions share the viewer's icon scale, including Copy's loading and success feedback. Text-only copies
retain their existing plain-text payloads. Copy does not recover Pending entries, transfer image
ownership, or alter the draft.

Browsers accept PNG clipboard images, not a general list of image files. PNG is copied directly;
JPEG, WebP and GIF are rasterized to PNG (one frame, without animation or source-file metadata).
The current item contains the first image and the original plain text, when present, as alternate
formats. A plain-text target pastes that text; an image target pastes the first image. With explicit
background-write permission, separate reverse-order writes also offer the other images to clipboard
history. Gesture-bound browsers receive one promise-backed item instead. Ordinary Paste does not
promise an entire image list; history remains a browser/OS capability, not Inspire state.
Original files remain available through their existing download flow.

Clipboard writes require browser clipboard support, a secure context and permission. Async Copy
declares its formats from the visible source and initiates the request inside the user's gesture,
before Host reads or image conversion can outlive that gesture. Every required source and image must
validate before any promised format resolves or success is reported. Unsupported formats, unavailable
source images, changed format metadata or clipboard denial report a warning instead of success or
silent text-only fallback. Large tool/custom text stays lazy until Copy is activated.
Source reads retain their existing authority: saved conversation images resolve exact content
coordinates, History images resolve the selected entry, and Pending images use the queue's
existing retained attachment handles. Unmount, source/view/transport retirement and Pending
revision changes cancel delayed copying before it can write or report success for another source.
A newer clipboard action retires pending reads across controls, including Copy last response.
The operating system cannot retract a clipboard write already accepted before retirement.
Transient confirmation belongs to the copied source: changing a file or project path, report, or
code block retires its old busy/success feedback without replacing the focused control. Current
copy failures use the shared warning or the surface's local recovery message; retired failures
must not report against replacement content.

Icon-bearing Copy actions show Copy at rest, the shared Π loader while pending, then Check after a
successful write. The fixed icon slot uses a short fade/scale transition without moving the button or
nearby labels. Reduced motion removes that transition. Text buttons reserve room for their alternate labels; loading is not artificially
prolonged. Path labels and terminal-selection confirmations keep their existing
context-specific presentation rather than becoming icon buttons.

## Searchable-surface focus

On primary touch/no-hover devices, opening the model picker, Command Palette or project-file
picker focuses its non-editable list/panel rather than the search field. Search starts when the
user taps the field; opening a chooser must not summon the software keyboard. Desktop retains
search autofocus, including in narrow windows. Explicit text actions such as Rename and prepared
command editing still focus their input. Returning to the palette list follows the same device
rule. Modal containment, nested portals, keyboard navigation and opener restoration remain intact;
result updates and viewport resizing must not steal focus from a field the user has entered.

Narrow Command Palette rows stack descriptions below their titles on the same left edge;
rows without a description keep their title vertically centered within the touch target.
Wide palettes retain their compact, right-aligned secondary column.

## Action-button presentation

Icon-only actions have centered, nonshrinking square glyphs without native button padding. Code-block
Copy and Insert in terminal use 13px glyphs in separate 24px mouse / 36px coarse-pointer targets,
with an 8px touch gap. Focus rings stay inside the compact header, clear of its separator. Hover is
mouse-only; touch uses local pressed feedback. Direct-shell inline metadata actions use 24px fine-
pointer / 44px coarse-pointer targets; tool-result notice actions keep their separate sizing.

Copy, Fork, Pending Return/Clear and similar actions share three presentation types:

1. **Constant:** visible, with unchanged visibility and opacity across activation conditions.
2. **Emphasized:** visible and semi-transparent at rest; a specified condition reduces transparency,
   possibly to full opacity.
3. **Revealed:** absent visually at rest; a specified condition makes the action visible, possibly
   still semi-transparent.

Message/content action assignments:

| Surface | Type | Activation |
| --- | --- | --- |
| User-message Copy and adjacent Fork | Revealed | Hover or visible keyboard focus within the whole message |
| Tool, Thinking and CodeMode header Copy | Revealed | Expanded content only; hover or visible keyboard focus within that item's header |
| Branch/compaction summary Copy | Revealed | Expanded content only; hover or visible keyboard focus in its header |
| Displayed custom-message Copy | Revealed | Hover or visible keyboard focus within the message header |
| Extension text-widget Copy | Revealed | Hover or visible keyboard focus within the whole widget |
| Assistant-response footer Copy | Emphasized | Whole-message hover/focus changes desktop opacity from 0.50 to 1 |
| All Pending Copy, Return and Clear controls | Emphasized | Whole-panel hover/focus changes effective opacity from 0.75 to 1 |
| Selected History entry, image-viewer Copy, system error/update information, code blocks, direct Shell results, file/project paths and Terminal text-reader Copy | Constant | Visibility and opacity stay unchanged |

Pointer-retained focus alone does not latch Revealed actions on screen. Navigation folder and
session action columns use the same hover/visible-keyboard-focus distinction, with counts/ages
restored when actions recede. Keyboard focus is not forcibly blurred or restricted to the hovered
row; simultaneous hover and genuine keyboard focus may reveal both rows. Touch actions stay visible.

Collapsible activity/context content mounts Copy only while expanded, without a closed-state gap
or tab stop. Within that expanded state, Revealed actions retain layout space and keyboard access.
On devices without hover they are visible at 0.75 opacity; focus reveals them fully. Message-footer
actions also use 0.75 touch opacity. Icon colors retain their surface roles: full opacity does not
replace the deliberately subdued glyph color.

Pending uses 0.75 panel opacity, a transparent background and a quiet border at rest. Hover or focus
within restores full opacity, the shared surface and normal hairline. All actions stay locally opaque
and inherit this panel emphasis, without a second opacity layer. Content copying and source ownership
follow the shared semantics above. [[conversation]] and [[composer]] own their behavior.

Quiet text actions use Constant presentation: body-color ink, transparent resting fill/border and
standard inset/control hover/pressed surfaces without a visible border. Transparent borders preserve
layout space. Presentation follows the action's role:

| Role | Treatment |
| --- | --- |
| Subordinate exit/navigation | Quiet: form/pre-execution Cancel, Palette Back and Dismiss after login. Compact links and icon-close actions retain their unframed form. |
| Content/read recovery | Quiet, including Host status recheck. A retry that executes a restart retains execution styling. |
| Secondary history/navigation | Quiet: History pagination/Fork/Clone, earlier-branch Clone and directory-root shortcuts; root shortcuts keep compact mono text. |
| Primary/preferred execution or navigation | Emphasized: Save/Submit, Add/Reset, branch continuation and Back to latest. Response choices, active Cancel login and dangerous execution retain ordinary/primary/danger variants. |

The directory picker's editable path shares Welcome's canvas fill, line border, small radius and
inset focus mark, with mono text, soft wrapping and content-sized height above the bordered directory
list. Quiet styling preserves action availability, sizing and keyboard behavior. Copy availability
follows [Content copying](#content-copying), independently of presentation type.

## Responsive, motion, and accessibility

- Below the narrow-workbench breakpoint, navigation and contextual work become
  independent modal drawers instead of squeezing both side regions around
  phone-sized conversation content. Fixed narrow surfaces honor all four safe
  insets. Each drawer provides its own close button inside the focus boundary.
  Narrow drawers slide in from their respective edges as opaque surfaces. Navigation uses the
  theme's darkening overlay token; the full-width context pane has no redundant scrim. Narrow
  Settings enters with an opaque 8px rise while only its backdrop fades. Dismissal is immediate,
  and reduced motion removes entry animation.
- Motion explains a transient surface, disclosure, or live work. Shared durations are
  90ms micro, 150ms standard, and 180ms panel. Indeterminate loading/execution uses a seven-point
  square Π (11.6×11.6 in a 16×16 viewBox) inside the existing square icon slot. Row/column sweeps,
  outline tracing, breathing, outward propagation, side relay and gathering remain available;
  every complete 2.4-second animation cycle independently selects the next pattern with equal
  probability; repeats are allowed. Rerenders and status-label updates neither reselect nor interrupt
  the current cycle.
  Reduced motion displays a static Π. Sidebar working states use it; unread completion/failure use matching linked-dot check/cross.
  Tool rows and nested calls use the same settled glyphs. Not-executed and missing-result tools,
  and cancelled/unfinished child calls, use a static eight-point perimeter with an empty center
  in `--muted`; their distinct labels remain intact, without implying work, success or failure.
  Point cells and resting glyph footprints are square (1:1); light links keep a three-point check
  readable at 12/14px. Success/error
  colors and attention remain distinct, and reading still clears unread terminal cues. Generating, queued and executing tools keep one mounted glyph and
  uninterrupted cycle; tool status follows the name in both parent and nested rows. Refresh controls
  retain directional arrows at rest and replace them with Π while refreshing. Settings checks and
  terminal connection/initialization use Π only while work is actually pending; offline/passive
  connection markers remain static, and determinate progress is not replaced by this animation.
  [Composer presentation](#composer-presentation) defines its state halo. Short card/palette entrance
  and disclosure transforms are permitted. Reduced motion removes nonessential animation and collapses transitions to a
  negligible duration; each live-state surface retains a static indication.
- Text meets WCAG AA contrast, and graphical focus/status cues meet their UI
  contrast threshold. `:focus-visible` uses the shared 2px accent outline;
  clipped headers and file-path columns keep it inside the target without growing controls,
  shifting reading boundaries, or scrolling an ancestor to reveal the ring.
  Controls retain named roles, native semantic structure, visible keyboard
  focus, and focus restoration after overlay close. Touch controls occupy real
  layout space rather than overlapping pseudo-targets.

## Checks

- `tests/web/styles-contract.test.ts` checks that project CSS variable references have declarations.
- Theme bootstrap and overlay ownership have focused web tests; mock-host
  browser coverage checks desktop and narrow workbench behavior, including the
  320px and 390px controls, drawer dismissal, and keyboard/accessibility paths.
- Check affected visual roles in both luminosities and every palette where they appear, using actual
  foreground/background pairs and interaction states.

## Non-goals

- The system does not reproduce a reference application's palette, typography,
  artwork, or component identity.
- It does not mix botanical surface ladders, use a legacy
  mixed-case lockup, large decorative brand motifs, idle-state breathing,
  recurring completion celebration, or a second responsive component structure.
