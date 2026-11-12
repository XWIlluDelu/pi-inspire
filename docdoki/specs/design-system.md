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
  - tests/browser/{shell-layout,settings-layout,reading-navigation,palette-preferences,responsive-inputs,theme-colors}.spec.ts
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

## Contextual tools and disclosure

Judge simplicity over the complete interaction, not just the idle view. Hiding a useful control
does not simplify a task when it adds an activation step and then makes the user locate the
working surface or reconstruct its context.

- Keep local tools visibly associated with the content they affect. A non-modal tool's launcher
  and working surface must have an immediate, legible spatial connection: expand nearby or replace
  the launcher in place rather than appearing in an unrelated region.
- Preserve that connection through responsive changes and pane resizing. Position the launcher
  and surface as one interaction, not as independently placed decorations.
- Use progressive disclosure when it saves meaningful space or reduces competing information
  without making the task harder to discover or perform. Prefer an available compact control when
  disclosure merely trades visible UI for extra clicks, pointer travel and visual search.

Feature specs decide which tools remain visible and which expand on demand. Reviews and regression
checks cover the default state, activation, focus, dismissal and responsive continuity.

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
  on the operating system's own mask. Icon URLs are versioned so installed
  browsers discover revised assets.
- The transparent browser-tab favicon is also palette-independent: it keeps its
  pixel geometry and ink/white brackets, with neutral quartz-gray `#63676C` ticks
  in light browser chrome and silver `#B9C0C7` ticks in dark browser chrome,
  and no background or opacity change. In-app identity keeps its accents.

### Installed windows

Supporting installed desktop windows use Window Controls Overlay with `standalone` fallback.
Ordinary tabs, unsupported browsers and disabled Overlay reserve no custom row. The browser supplies
titlebar height and native controls; only its safe strip is draggable. Workbench content, dialogs,
drawers and focused terminals stay below it.

The uninterrupted strip uses `--bg-rail`, without subdivisions, bottom rule, gradient or shadow;
the navigation divider stops below it. Its `theme-color` follows palette and resolved luminosity
before first paint and after Host bootstrap, including system-theme and Overlay-mode changes.
Modal dialogs and narrow modal drawers also dim the entire installed titlebar, including its
wordmark and decoration, with the same palette scrim and stacking depth. The opaque `theme-color`
hint follows that composite so browser-owned controls keep no bright patch. Closing the last modal
restores the frame; window drag and native controls stay available throughout.

Ordinary tabs and standalone fallback use neutral `#F4F5F6` / `#14171A` page hints. The manifest
omits `theme_color`, because Chrome Android WebAPK can otherwise keep that installed color on the
system navigation bar after the page changes theme. Omitting it only removes that override; it does
not guarantee the native bar follows the page or system theme. Chrome can keep a native bar or make
it transparent in its edge-to-edge path, where native window and inset handling also affect the
visible background. The manifest keeps a neutral light `background_color` for native startup/window
use; its presence alone does not explain a persistent navigation-area color. Browser/OS support
determines native controls and installed-metadata update timing; page reload alone does not update a
WebAPK. Actual installed appearance requires device verification.

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
  and light/dark surface ladders. **Carbon & Silicon** (`mono`) adds neutral gray surfaces
  and monochrome interface emphasis, inspired by VS Code Light Modern / Dark Modern.
  Chimonanthus is the default. Light, Dark, and System select luminosity independently of the
  palette.
- Display presents seven named color swatches in two columns, keeping complete names reachable on
  narrow screens. The botanical palettes come first, then Jade and Amber; Carbon & Silicon is last
  and spans the full picker row. The selected choice has a border and pressed state, not color alone.
- Saved `amber` migrates to `chimonanthus`; saved `teal` (formerly Jade) migrates to
  `hydrangea`. The next successful preference write saves canonical identifiers. The browser's
  visual cache applies the same migration before React starts. Host preferences are authoritative
  after bootstrap.
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
  | Carbon & Silicon | `#4B4B4B` | `#3B3B3B` | `#C8C8C8` | `#D7D7D7` |

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
  Component structure stays independent of palette. Resting navigation search uses `--bg-control`; the topbar blends 88% `--bg-stage` with
  `--bg-rail`. Components use shared roles rather than local palette values.
- File inspection is the deliberate exception: its host-owned Preview, Source,
  and Changes canvases use the luminosity-aware `--bg-file-*` neutral ladder,
  which is identical across all supported palettes. Product chrome stays
  palette-aware, rendered artifacts keep their authored backgrounds, and
  source syntax and Diff additions/deletions keep semantic color. Syntax and Git
  text use luminosity-aware colors with AA contrast on their neutral or tinted
  reading surfaces.
- Carbon & Silicon uses a continuous neutral frame around the existing workbench, with lighter
  content in Light and a slightly lighter reading stage than the frame in Dark.
  Error, warning, success and Git state colors remain semantic. Carbon & Silicon's code
  containers keep the Chimonanthus syntax colors through scoped token values; the highlighter,
  token mapping and other palettes are unchanged, and there is no separate selectable code theme. Upstream attribution and the MIT license ship in
  `public/licenses/vscode-themes-MIT.txt` (and the built `licenses/` directory).
- Small status text uses `--success-ink`, `--warning-ink`, `--info-ink` or `--error-ink` on neutral
  and tinted surfaces. By default, `--error-ink` mixes 70% palette error with 30% primary ink.
  Carbon & Silicon Dark mixes in more primary ink to keep danger menu text legible on hover
  while keeping its original red marks and fills. Outlined, quiet and menu danger actions and
  activity-fold loading failures keep `--error-ink` through hover, press and focus. Danger borders
  and tints use `--error`. Successful command badges use `--activity-success-ink`. Status icons,
  borders and tints keep their semantic color. Text contrast, including faint text, holds on its
  actual surface in every interaction state.
- Tool and Thinking have distinct icon identities on neutral, unframed reading surfaces; failure
  never recolors those identities. Context-event/extension glyphs and ongoing compaction use
  `--activity-event`, an alias of `--activity-tool`; context and extension glyphs keep this unmixed
  identity color, and compact progress text uses `--activity-event-ink` on its tint. Their
  attribution, surfaces and disclosures stay distinct from tool executions. Ordinary notices and command outcomes use
  information/success/warning/error roles, independent of activity identity.
- Error/Stop uses raspberry-red, distinct from Lycoris's decorative red. Light semantic ink is
  deeper than accent fills; dark semantic ink is lifted. Navigation combines color, positioned
  marks and accessible state: working uses Π in the warning role, completion uses success,
  failure uses error, and recovery has its own visible treatment. Color alone never carries state.

### Neutral strokes

- `--line` supplies ordinary structural dividers and resting boundaries. `--line-strong`
  supplies emphasized neutral edges, including stronger control boundaries and hover states.
  Stroke widths are separate. Classic Jade and Amber use ink-with-transparency strokes.
- `--hairline` and `--hairline-strong` alias those roles in every palette/luminosity combination;
  `--line-subtle` aliases `--line`.
- Botanical strokes follow their paper temperature: light Wisteria `#DAD6E4`,
  Hydrangea `#D6DDD4`, Lycoris `#E0D6D2`, Chimonanthus `#DFDAD0`, with individually
  tinted dark counterparts. Focus and semantic status keep their own roles.

## Type, geometry, and spatial hierarchy

| Font | Role |
| --- | --- |
| IBM Plex Sans SC | Interface controls, prose, Chinese/Latin flow and wordmark. |
| Flux Mono SC | Code, paths, identifiers, timestamps, shortcuts and machine data. |
| Bundled KaTeX faces | Mathematical glyphs. |

Latin core faces load with the shell. The complete checksum-pinned CJK registry loads after
authoritative bootstrap so it does not compete with first render, and fetches only used Unicode
subsets. Structural labels (`--font-label`: resource tabs, Settings section headings and command-palette
group headings) share IBM Plex Sans SC in authored sentence case without tracking, using 500 (600
for Settings sections, selected resource tabs and palette groups). Activity headers, boundaries and
Earlier activity are an ornament, not content: Flux Mono SC eyebrows at 11.5px and 400, uppercase
with 0.08em tracking, never louder than the 12.5px tool rows they contain. The expanded summary's
counts and tool names stay in authored case. Code-block language labels share that eyebrow.
Reply headings use balanced wrapping and prose uses pretty wrapping, so no heading or paragraph
ends on one stranded word. Task-list marks in prose are content, not controls: neutral ink and a
quiet fill when checked, without the accent. Other headings also keep
authored casing; technical identifiers keep their spelling.

The type scale is 11.5, 12.5, 14, 15.5, 17, 21, 26 and 32px, with maximum weight 600. CJK running
text has no tracking; short uppercase Latin labels may use restrained tracking. Compact, Comfortable
and Large presets remap conversation prose, headings, code, reasoning, tables, drafts and text
previews; interface controls keep fixed tiers. These tiers apply at every viewport width: path,
search, picker, dialog and rename inputs retain their owning control's typography. Responsive
layouts may enlarge control surfaces and touch targets without enlarging input text. Composer
text follows the selected content-size preset without a narrow-screen minimum; Compact remains
14px, Comfortable 15.5px and Large 17px. Browser-specific focus-zoom handling stays local to a
demonstrated affected surface, such as the sidebar's existing iOS editing exception.

Reading tables use a separate data-text tier: 12.5px Compact, 14px Comfortable and 15.5px Large.
They sit one step below prose, above the smaller tool/metadata tier, and keep semibold headings,
tabular numerals, quiet row rules and local horizontal scrolling.

Activity disclosure marks and Settings icons align optically with uppercase letters. The nine-dot
activity matrix uses its own smaller optical correction rather than inheriting the chevrons' full
upward correction; alignment is judged against the complete dot pattern and rendered letterforms. A wrapped
Settings title keeps its icon beside the first line, outside the font line box, and its action
independent of that group. Dialog titles, prose and deletion errors wrap long paths or identifiers
within their content edges. Settings status and Host availability explanations stay within their
text columns, preserving payload text, field widths and action geometry.

Shared geometry follows a 4px spacing scale: 2px inline corners, 4px controls, 8px resting surfaces
and 10px overlays. Composer uses the 8px surface radius; user message bubbles use 14px.
Fully round `999px` radii are for capsules, status geometry, scroll thumbs and
thin resize strokes. Inset menu highlights and compact file/search/terminal actions, including PDF Fit, use the
control radius; model-list highlight insets leave virtual-row heights unchanged. Nested radii account
for parent padding/borders; provider fills use outer radius minus border thickness. Focus follows the
control silhouette, including terminal tabs' rounded upper corners and square content join. Settings
and navigation selection markers are thin and round-ended.

Neutral surfaces, hairlines and whitespace express depth. Elevation combines contact and ambient
shadows: `--shadow-1` is faint and absent in dark mode; `--shadow-2` lifts menus/notices in light and
classic dark palettes, while botanical dark uses borders and surface contrast; `--shadow-overlay`
separates dialogs/drawers. Shadows supplement borders without adding an outline. Reading, navigation
and contextual shells have no elevation. Composer has no resting shadow; it uses a crisp focus
boundary with a faint close ring, alongside its independent state treatments.

[[workspace-layout]] owns pane geometry and resizing. Reading/Composer measures are Narrow 680px,
Comfortable 820px and Wide 980px, bounded by center-pane width.

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

The 44px topbar aligns the regions. Its 28px utility buttons form a compact 4px-gap group on
fine-pointer desktop without changing the trailing anchor. Connecting/reconnecting uses a quiet,
unboxed, accessibly named transport hint that disappears on recovery; offline and Host failures
keep warning treatment. While the central workspace-loading state is visible, omit the transport
hint but still show failures. Once loading settles, a status region without session identity is
vertically centered in the topbar; a selected session keeps the shared text baseline between
identity and status.

The navigation header pairs a noninteractive reticle/wordmark with the sidebar-outline Collapse
button. New session is a quiet full-width row above Search, with control-radius neutral hover and
no resting box, shadow, badge or header divider. New/Search share height, font size, a 16px icon slot
and baseline; New has slightly heavier text and a neutral plus. Their gap is 8px, followed by 16px
before projects, including in the Overlay header. The collapsed rail's mark expands navigation and
its separate plus starts New; both logo forms share size and icon axis.

New, Search, folder and session titles share a text axis. Status marks use the existing 16px
folder icon slot at every width; working, completion, error and attention states never shift or
narrow the title. Folder counts stay at the trailing edge, and folder and session actions share
trailing columns. [[workbench]]
owns one- and two-line session row layouts and action visibility. In Hidden, individual sessions
precede folders and keep the shared text axis. Narrow/coarse-pointer
New/Search rows are 36px high with 14px labels; icon-only rail/close actions retain 44px targets.
WebKit uses 16px editing text to avoid focus zoom, retaining compact resting labels.

The contextual tab/tool header is 32px on fine-pointer desktop, 36px on coarse-pointer desktop,
and at least 37px in its narrow drawer. Its icons remain 16px; desktop tool tiles are 26px high
while coarse/narrow controls keep at least 32px targets. Open-file tabs fill the header height,
and the short refresh separator remains centered. Narrow drawers and compact touch panes use a
second row when a selected file or terminal tab, overflow and tools cannot fit together. An empty
shared strip does not reserve that row.

Files, Changes, History and Terminal share the contextual pane. Resource safety and change
semantics belong to [[resource-preview]]; branch behavior belongs to [[session-branches]].

The contextual header keeps file and terminal tabs in one leading strip with a shared More tabs
menu instead of horizontal scrolling. Files, Changes and History use trailing icon tabs;
Terminal is a default-shell creation action. File and terminal labels use the small UI tier. The rail-colored header has one weak hairline against stage-colored
content. Selected file/terminal tabs keep content-colored fill, accent ink, weak top/left/right edges
and small top-only corners, with an open bottom joining the content. Fixed Files/Changes/History
selections share that connected surface and boundary, with no additional underline, as specified in
[[workspace-layout]]. Hover, transparent close buttons and keyboard focus keep their existing roles.
The Changes count uses tabular digits next to its icon on the same centerline, inside the tab in
either state. The visible count caps at `99+` and the tab title gives the exact total.
Other segmented controls keep their own selection surfaces. Count capsules use
`--accent-tint`/`--accent-deep`, smaller text on the label baseline and a distinct gap.

Session, conversation and workspace search use muted icons/placeholders and ink-colored input,
stronger hover icons and accent focus borders. Session search rests on an inset control surface with
a fine boundary that strengthens on hover and changes to surface fill on focus.
Workspace search keeps an opaque surface fill and fine resting border. Conversation search has an
opaque fill distinct from the reading stage, the shared control radius, a quiet boundary and the
light shadow; hover strengthens the ink, and focus or a non-empty query uses the accent boundary,
without changing geometry or letting scrolling text show through.
Conversation search takes its width from the reading stage. The field's leading edge and the
navigation buttons stay anchored as the query changes. The field can yield trailing space to a
compact numeric count with a full accessible announcement. Navigation buttons keep at least 24px
targets, with 36px targets for touch and phone layouts, clear of the count.
Workspace and History search share a 34px field, 13px search icon, 12px inner inset and
8px icon/text gap, starting 4px below the contextual tool header.

Selected session rows have a translucent lifted surface; collapsed folders containing the selection
have a quiet accent tint. Both use an inset straight, round-ended accent marker, with neutral ordinary
hover that lifts toward the ink (6%) in light and dark alike, never an inset well. The row retains selection fill even when its select button is disabled. Folder rows/headings
use control-radius corners, a clear icon gutter beside the marker and a common text axis with their
sessions. Folder, Workspace and Hidden keyboard outlines remain inset within clipping boundaries.

Folder groups use an 8px margin plus the 2px list gap in the catalog and Hidden. Pinning, expansion,
and input mode keep the same spacing between folder groups. The titled Pinned sessions section
uses a 20px margin before the first folder. In Hidden, the 8px margin also applies before the first
folder following independent sessions.
Runtime status stays on each session's existing row; sessions are not duplicated into separate
status groups.

## Conversation surfaces

User messages are right-aligned, content-sized bubbles with 14px corners, a borderless `--bg-prompt`
fill and no accent edge; every dark palette keeps that fill a visible step above its stage. Copy/Fork fit to the bubble's left with an 8px gap and bottom-aligned targets; otherwise
they wrap below at the same right edge with a 4px gap. This rule covers text and image-only bubbles
without shrinking or rewrapping them; bubbles and attachments stay within the reading width.
Actions use centered 13px glyphs, 24px mouse or 32px narrow/touch targets and a 4px inter-action
gap; assistant response Copy uses the same target sizes. Visibility follows
[Action-button presentation](#action-button-presentation).

User-bubble prose starts flush left and shares assistant prose's reading rhythm: the
`--leading-reading` line height (1.6) and a 0.75em gap between paragraphs. Single line breaks and
automatic wrapping follow the same line height.

Assistant prose and expanded Thinking use open reading flow. File references in prose read as links: accent mono text with a faint
underline that firms on hover, without the inline-code chip, which stays for code that is not a file. Activity headers are transparent
disclosure rows; [[activity-presentation]] owns their guides, density and reading rhythm. Context
events share the leading disclosure axis and transcript-row gap, without extra outer inset. Titles
keep intrinsic width; adjacent metrics wrap to the title's text axis and share its baseline. Expanded
text uses the same anchor, while Copy centers independently of its hit target. Row hover strengthens
ink without a fill; keyboard focus uses a rounded outline.

Custom messages use a bordered `--bg-surface` without a colored edge, a package/type header, readable
Markdown and separately folded Details. Configured attribution and subdued source share a baseline;
header, body and Details share a reading anchor, with Copy in its own column. They inherit neither
tool status nor activity density. Pi errors use a compact neutral surface with a subtle error border and no
shadow, a semantic label and readable reason, with bounded inset diagnostics.

Error, extension and shell headers fit touch Copy targets within their padding without enlarging the
text row. Shell sections own their inset without a second turn-layout gap. Pending Copy centers on
the first line while wrapped previews keep balanced vertical padding.

## Composer presentation

The Composer is one reading-width instrument: attachments/references above the writing field,
Steer/Queue in a dedicated delivery row, and a quiet metadata toolbar below. Its writing surface has
12px corners and a quiet border; spacing separates the rows without an internal divider. Attachment
corners use the control radius. Input text, the delivery row's outer edge and the model label share
one horizontal content anchor, including on phones, while selector hit areas retain their padding.
On fine-pointer desktop the outer padding is 8px horizontal and 12px vertical. The input,
attachments and model label share the resulting 18px inset from the outer border, with an 8px row
gap and unchanged height. Desktop reading stages wider than 440px use an 8px separation between
settings and file actions; gaps within each group stay at 4px. Narrow/coarse layouts keep their
existing padding and wrap behavior.

Attachment file chips put filenames and state ahead of technical metadata. Pending's visual
emphasis follows [Action-button presentation](#action-button-presentation); [[composer]] owns
bounded summaries and action semantics.

Toolbar order is Model, Thinking, project files and attachments, optional Expand or Collapse,
context usage, optional Stop, and rightmost Send. Expand and Collapse use the local utility-button
size and keep the writing width fixed. Context usage fits the same toolbar row as Send and preserves
the empty composer's height. Send is icon-only. Stop has a square glyph and filled error-color
treatment, including compaction and shell cancellation. DOM and tab order follow visual order.
At viewport widths up to 460px, Model and Thinking share the first row, with file tools, editor
size, context and Send/Stop below. Selectors in the compact arrangement stay adjacent with an 8px
gap. Thinking keeps its full width and Model shrinks without filling spare space. Long model labels
truncate inside their trigger. Steer/Queue split their row equally. Constrained desktop panes also use the
compact arrangement under [[workspace-layout]]. Completion titles wrap without displacing
adjacent path hints. Model badges and selected rows keep AA contrast.

Running uses a close, low-opacity theme halo with a 3.6-second opacity cycle. It intercepts no pointer
input and changes neither geometry nor shadow properties; the normal border and independent focus
border remain. Reduced motion keeps a static low-intensity halo. Retry and Compaction use their own
static semantic halos; conflict recovery keeps warning treatment. [[composer]] owns delivery state,
including when recovery is the sole action.

Command feedback uses neutral surfaces and semantic icons/text, without panel-wide status washes or
competing running glows. Failed receipts are unframed, wrapping inline feedback with a compact Dismiss
action; action-rich results may use local containers. Extension widgets have a small identity/Copy
header and readable preformatted content in Pi's above/below-editor placement. Extension questions
remain distinct attributed forms with directly selectable options.

## Feedback and notices

- Choose feedback by the user's task, not by the number of internal states. Where ordinary
  selections or saves need feedback, use the existing control's busy/disabled state; do not append
  progress sentences or reserve empty rows for routine internal work. Keep useful option guidance
  visible while waiting. Distinguish internal request and execution phases only when that changes
  the user's available action or understanding of the outcome. Reading an action's availability must
  not animate that action as if the user had started it.
- Keep usable content during background work. An empty initial view or a materially blocked task
  may need concise loading feedback; a populated picker, provider list or update result needs no
  second progress announcement. Keep unrelated actions, such as copying the known result, usable.
  Preserve actionable errors, consequential confirmations, genuine task progress and notices that a
  saved change needs a reload or restart.

- Session and usage use the shared Info command receipt: the information icon, command/INFO heading
  and subtle semantic tint match other informational results. Only message count, total tokens,
  cost and context occupancy appear, as compact inline label/value pairs that wrap with the
  available width. Project, model, session name and raw JSONL path are omitted, with no secondary
  disclosure. There is no separate panel title, divider, metric grid, highlighted cost or duplicate
  progress bar. Long values stay readable. Repeating the query updates the same card in place
  without increasing dock height or restarting an entrance animation; a single readout does not
  stack. The bounded, focusable dock keeps keyboard/touch scrolling when distinct results need it.
  When usage is unavailable, the result says so instead of rendering an empty Info receipt.
- General notices use compact icon/message/action rows without a visible severity heading.
  Severity is still announced, and extension attribution stays in the message. Short messages size
  to their content within the stack's width; diagnostics wrap without losing Copy/dismiss. Those
  actions keep 24px mouse or 32px touch targets, aligned with the message's first line. Embedded
  resource errors and richer update cards keep their contextual presentation.
- Placement: Welcome and conversation views share one floating feedback owner and presentation; a
  page transition does not move notices into page flow or widen them to the start composer's width.
  Notices anchor at the top-right at every width, below the header, current banners and any
  overlapping transcript search or mobile tool row, and the stack stays above the bottom safe inset.
  Editor height does not move this anchor; the editor's top edge only limits the scrollable stack
  when their horizontal ranges overlap. Placement follows toolbar, editor, banner and pane resizing.
  Empty space beside content-sized cards does not intercept input. Non-modal notices sit below
  active modal dialogs instead of covering their content or controls. On narrow layouts, navigation
  and resource drawers also own modal interaction: notices sit below the drawers and any scrim, keep
  their contents, and return to the normal layer on dismissal.
- Overflow: only an overflowing stack scrolls, without compressing cards or discarding diagnostic
  text; fitting stacks keep their normal width, shadows and placement. Additional notices preserve
  an existing reading position. Copy, dismiss and keyboard scrolling stay reachable.
- Expiry follows meaning and ordinary text volume, not Info tint alone. Short INFO confirmations and
  bare Name normally have a 3-second reading dwell; one- or two-sentence guidance such as Quit has 5
  seconds; denser INFO and the four-field Session & usage readout have 8 seconds. Exact repeated
  notices coalesce in place and renew their dwell. Hover, focus within, an active pointer press and
  a hidden document pause the clock. Reading time starts only when at least half of the card is in
  view and pauses when it scrolls out of that range; resuming keeps the remaining time, with at least
  3 seconds to finish reading. Expiry uses only a standard 150ms opacity fade, omitted for reduced
  motion. Manual dismissal is immediate. Errors, warnings, export actions and update availability do
  not expire on these timers. State-owned progress, extension widgets and retained transcript
  content keep their own lifecycles. [[composer]] owns query/session boundaries and command outcome
  handling.
## File and path labels

Workspace, Changes, project-file pickers, inline completion and uploaded/sent file tags share the
filename-based monochrome file-category icons; unknown types use a neutral document. Compact file
rows and completion use 13px icons. Image attachments keep their thumbnails. Pickers and search
results separate filename from parent directory, omit empty root-level captions, and keep the exact
path in titles and accessible names. Literal query-term emphasis uses weight 600, inherited ink and
no background; feature specs define matching and row layout.

Semantic path labels keep one exact value for assistive text, tooltip, Copy and navigation. A
fitting path stays complete; only actual container overflow elides it, parent before filename, with
no breakpoint or percentage quotas. Ordinary titles and bare filenames keep their own text treatment.

## Shared labels and controls

- Mixed-case buttons, inline actions, segmented controls, dropdown values, context-tab labels,
  branch labels, model Common/Default choices, navigation dock rows and custom-message attribution
  center text and icons together without a blanket text-only offset or compensating padding.
  Fixed-height settings and content-sized actions share this alignment; button dimensions, icon
  sizes, local spacing and hit targets stay unchanged. System icon/text actions keep their shared
  8px gap. Large dialog headings keep their own optical correction. Custom-message icons and Copy
  center against the attribution group, including when the sender wraps.
- Settings field labels and help use whole-pixel 19px and 17px line boxes so adjacent action rows
  share the same raster baseline; reading prose keeps its normal line boxes.
- Button sizing follows local visual balance, not a shared equal-width rule. Stateful actions
  reserve room only for their own labels where feedback would otherwise disturb the action row;
  different actions and command delivery modes keep content-sized widths. MCP, provider and model
  forms use `Save` without repeating the configuration context; MCP uses `Saving…` while pending.
  Command preparation uses concise `Run` / `Send` labels, and `Steer Pi` / `Queue prompt` for
  busy-task delivery; it keeps the submitted action's label footprint while awaiting acceptance.
  Export stays a text action in both states, with no icon added while busy.
- Searchable menus use the same accent tint for pointer hover and keyboard candidates. Pointer
  movement and arrow navigation select one highlight mode; leaving a row removes its hover without
  dismissing the panel or blurring its search field. Checkmarks and `aria-selected` identify committed
  values independently of that candidate highlight. Settings model search stays neutral until keyboard
  navigation or an explicit row action.
## Overlays and deferred surfaces

Modal overlays use the shared radius, hairline, elevation, restrained scrim, 2px backdrop blur and
short 0.97→1 pop-in. [[interface-preferences]] owns modal focus, keyboard priority and extension-question
suspension. Anchored menus keep their trigger gap while accounting for overlay scroll, fixed-position
coordinates and reserved window chrome.

Modal frames respect all four safe-area insets, including landscape layouts. Settings and Terminal
settings share a narrow frame with fixed navigation/footer, filling the overlay's remaining height.
Narrow category selection uses an accent underline and keyboard outline, without card fill, border
or shadow. The utility footer keeps full installation/reset labels and their keyboard outlines inside
the frame, including at 320px. Installation actions use the shared sans face; the most constrained
installed/installable state tightens metadata and action spacing rather than truncating labels.
Update rows (Pi, Extensions and INSΠRE) use the standard section/card geometry. The check action
reserves the width of its longest complete icon/label state and centers the currently visible icon
and label together, using the shared mixed-case action alignment and 8px gap in loading and result
states. Update checks show one `Checking…` button state from request through completion, while the
rows keep the last observed versions and available updates.

Deferred surfaces keep one interactive shell and focus owner through loading, ready and failure.
Loading visuals appear after 250ms, immediately under reduced motion, without delaying ready content
or errors. Settings skeletons preserve column, navigation, card and footer geometry but are excluded
from the accessibility tree and tab order. Context, History and Pi release notes share centered
status/recovery presentation: loading Π with concise status; failure alert with an unavailable title,
the actual error as a secondary hint (never a repeat of the title) and quiet Retry. State content
owns its padding independently of document/help content.

## Settings forms, disclosures and configuration actions

Section headings and descriptions sit above independent bordered field cards, without tinted header
bands. General and Terminal settings share shell/content insets across viewport sizes; card-level
empty/error messages use the field rows' content inset. Asynchronous descriptions anchor at the top,
with actions before feedback; meaningful feedback remains readable in normal flow without reserving
blank space for routine progress. Cards and sections do not clip menus or focus. Checked switches use
the shared accent fill/foreground pair, and category/palette selection retains explicit markers.

Settings and Terminal settings share 32px mouse / 40px touch fields, switches, steppers and
segmented controls. Ordinary dropdowns, segments and the palette grid share a choice-column width.
Segments use a recessed group with a neutral selected surface and edge; named palettes use independent
bordered tiles with an accent-tinted selected surface and accent border. Both keep stronger selected
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
activation and the shared rotation transition; each disclosure keeps its own default open/closed
state.

Configuration sections put their Add action beside the section title. Provider, declared-model and
MCP entry rows share quiet trailing Edit/Remove icons with accessible names and tooltips; confirmation
stays separate. Provider/model nesting and User/Project MCP grouping keep their distinct meaning.
Focused configuration fields reveal their label after layout without taking focus back from another
owner. Short windows scroll the complete editor instead of collapsing the field viewport, with
Save/Cancel pinned above the Settings footer and clear of the focused field.

## Native choice controls

Ordinary checkbox and radio inputs share a 14px skin: strong neutral borders and control surfaces
when unchecked, accent tint with a check or dot when checked. Checkboxes are square and radios
circular. Native inputs keep their labels, grouping, keyboard operation and disabled semantics.

Keyboard focus uses the shared accent outline. Models owns focus and disabled fading on the whole
choice label, so its input has no second outline or opacity reduction. Other disabled choice inputs
use one opacity reduction. Forced-colors mode restores native appearance and removes the custom marker.
Settings switches keep their separate skin. Markdown task markers use the shared appearance at 13px,
with document margins and -0.15em vertical alignment. Check/dot markers center inside the input without
changing box position or line height. Recorded task states are noninteractive at opacity 1.

## Model-list hierarchy

The Composer model popover is capped at 384 × 456px, with viewport-aware placement. The shared
Thinking popover starts at 208px wide, with 30px desktop and 44px touch option rows.
Both pickers inset row highlights by 6px and keep a 12px text edge. Composed Thinking controls add
8px vertical padding around the status-bound choice group without changing the native option rhythm.
Its range input shows keyboard focus around the selected dot, not a clipped rectangle across the
labels. The two pickers' bounds reflect their different content densities while preserving text size
and model identity.

The shared model picker uses transparent provider/group headings with a thin ordinary-stroke bottom
rule and a 28px virtual-row height. Long headings elide on one line; their title and accessible group
label keep the full provider name. Settings provider headings also use transparent surfaces with
their own typography. Recent, Router and No thinking labels use muted, normal-weight text without a
filled badge.

## Search presentation

Session, workspace and History search share an explicit clear control. It remains available while
search is loading, restores input focus and does not add a second native clear button. Loading uses
the leading icon slot without displacing Clear. Each search keeps its own query, Escape, navigation
and IME semantics, surface geometry and loading announcements. Files and History inputs retain
`--text-sm` (12.5px) text and 13px leading icons at every width, including placeholders and editing;
narrow layouts enlarge their control height, not their type. The sidebar keeps its compact 14px
navigation labels with the localized WebKit editing exception defined above. Other search surfaces
keep themed native clearing and their own keyboard rules.

Session titles and visible project names/context emphasize matching text at weight 600, without
changing colors, backgrounds, ellipsis or direct Pin/Hide controls. Visible token emphasis uses Pi's
greedy subsequence projection, including its letter/digit swap; phrase emphasis preserves native
whitespace normalization. Host result filtering remains under [[session-continuity]]. Regex queries
and matches confined to hidden fields have no browser-side visible emphasis.

## Command Palette

The palette uses a 580px desktop maximum width, bounded by the viewport. Search text, group titles
and result titles share a 20px content edge; candidate highlights keep their own outer inset.
Default groups distinguish `Actions`, `Workspace` and `Sessions`, with compact overline headings and
tighter spacing between sections. Transparent group headings use a `--line` bottom rule that
replaces one pixel of padding, preserving heading height and text position; there are no
full-width shaded bands. Long titles use up to two lines. Omit redundant action descriptions without
removing useful search aliases.

Visible title matches use weight 600 and secondary hint matches weight 500. Hints keep their
secondary color, size and placement; aliases and cross-field matches remain search inputs without
invented visible matches. The accent-tinted candidate is the action highlight; shortcut hints stay
separate.

Wide palettes keep a compact, right-aligned secondary column. On narrow screens, descriptions and
project/age metadata stack below titles on the same left edge; rows without a description keep
their title vertically centered within the touch target.

## Extension question choices

Immediate-submit choices distinguish current keyboard focus and pointer hover without a check
that implies an answer has already been submitted. Focus keeps a visible accent outline;
hover and press use the raised neutral surface with a fine neutral inset boundary, distinct from
the recessed list in light and dark themes. Choices support Click/Enter submission and
roving keyboard navigation.

## Compact menus

Dropdown options, session actions, Settings move options and terminal menus share a raised surface,
hairline border, medium radius, compact padding and entry motion.
Action rows use the same small UI text, accent-tint interaction feedback and inset focus role.
Each owner keeps its action/selection semantics, anchor, grouping and viewport constraints;
searchable model lists and descriptive project groups keep their information hierarchy.
An open dropdown follows its trigger while scrolling and closes once the trigger is fully clipped.
Session actions size to their content within viewport bounds, with drag handles in a separate
trailing column. [[workspace-layout]] owns compact disclosure and [[interface-preferences]] owns
saved ordering.

## Content copying

Copy availability follows the content, not a text-only projection. Image-only user messages and
image-bearing tool/custom content keep their established Copy action; the shared image viewer
also offers a constant Copy for an inspected saved or attached image. Its Copy, Download and Close
actions share the viewer's icon scale, including Copy's loading and success feedback. Text-only copies
keep their existing plain-text payloads. Copy does not recover Pending entries, transfer image
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
Source reads keep their existing authority: saved conversation images resolve exact content
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
nearby labels. Reduced motion removes that transition. Text buttons reserve room for their alternate
labels; loading is not artificially prolonged. File-preview Copy path uses this icon feedback in its floating action group; other path
labels and terminal-selection confirmations keep their existing context-specific presentation.

## Searchable-surface focus

On primary touch/no-hover devices, opening the model picker, Command Palette or project-file
picker focuses its non-editable list/panel, not the search field, so opening a chooser does not
summon the software keyboard; search starts when the user taps the field. Desktop keeps search
autofocus, including in narrow windows. Explicit text actions such as Rename and prepared
command editing still focus their input. Returning to the palette list follows the same device
rule. Modal containment, nested portals, keyboard navigation and opener restoration remain intact;
result updates and viewport resizing must not steal focus from a field the user has entered.

## Action-button presentation

Icon-only actions have centered, nonshrinking square glyphs without native button padding. Code-block
Copy and Insert in terminal use 13px glyphs in separate 24px mouse / 36px coarse-pointer targets,
with an 8px touch gap. Code blocks have one frame: the language eyebrow and actions float above the code with no
divider, and focus rings stay inside that compact header. Hover is
mouse-only; touch uses local pressed feedback. Inline full-output actions in tool notices and shell
records use 24px fine-pointer and 32px coarse-pointer targets, including in History. Tool notices
add 2px vertical padding per side. Shell records keep their own footer padding, and notices wrap
when their text and actions need more room.

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
| Assistant-response footer Copy | Revealed with a fine pointer; Emphasized (0.75) on touch | Whole-message hover or visible keyboard focus |
| All Pending Copy, Return and Clear controls | Emphasized | Whole-panel hover/focus changes effective opacity from 0.75 to 1 |
| Selected History entry, image-viewer Copy, system error/update information, code blocks, direct Shell results, file/project paths and Terminal text-reader Copy | Constant | Visibility and opacity stay unchanged |

Pointer-retained focus alone does not latch Revealed actions on screen. Navigation folder and
session action columns use the same hover/visible-keyboard-focus distinction, with counts/ages
restored when actions recede. Keyboard focus is not forcibly blurred or restricted to the hovered
row; simultaneous hover and genuine keyboard focus may reveal both rows. Touch actions stay visible.

Collapsible activity/context content mounts Copy only while expanded, without a closed-state gap
or tab stop. Within that expanded state, Revealed actions keep layout space and keyboard access.
On devices without hover they are visible at 0.75 opacity; focus reveals them fully. Message-footer
actions also use 0.75 touch opacity. Icon colors keep their surface roles: full opacity does not
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
| Subordinate exit/navigation | Quiet: form/pre-execution Cancel, Palette Back and Dismiss after login. Compact links and icon-close actions keep their unframed form. |
| Content/read recovery | Quiet, including Host status recheck. A retry that executes a restart keeps execution styling. |
| Secondary history/navigation | Quiet: History pagination/Fork/Clone, earlier-branch Clone and directory-root shortcuts; root shortcuts keep compact mono text. |
| Primary/preferred execution or navigation | Emphasize Save/Submit, Add/Reset and branch continuation. Response choices, active Cancel login and dangerous execution keep ordinary/primary/danger variants. Restore saved position uses a quiet action in the continuation notice. |

The directory picker's editable path shares Welcome's canvas fill, line border, small radius and
inset focus mark, with mono text, soft wrapping and content-sized height above the bordered directory
list. Its title stays on the leading edge and its visibility action aligns with the trailing content
edge. Quiet styling preserves action availability, sizing and keyboard behavior. Copy availability
follows [Content copying](#content-copying), independently of presentation type.

## Responsive, motion, and accessibility

- Desktop and narrow layouts share component styling and information hierarchy. Adapt layout,
  touch targets and control visibility where screen space or input method requires it. Welcome
  recent-session rows keep their shared radius, flat surface and pressed background on phones;
  larger targets and padding provide the touch adaptation.
- Below the narrow-workbench breakpoint, navigation and contextual work become independent modal
  drawers that slide in from their respective edges as opaque surfaces. Fixed narrow surfaces honor
  all four safe insets. Each drawer has its own close button inside the focus boundary. Navigation uses the
  theme's darkening overlay token; the full-width context pane has no redundant scrim. Narrow
  Settings enters with an opaque 8px rise while only its backdrop fades. Dismissal is immediate,
  and reduced motion removes entry animation.
- Motion explains a transient surface, disclosure, or live work. Shared durations are 90ms micro,
  150ms standard, and 180ms panel. Short card/palette entrance and disclosure transforms are
  permitted. [Composer presentation](#composer-presentation) defines its state halo. Reduced motion
  removes nonessential animation and collapses transitions to a negligible duration; each live-state
  surface keeps a static indication.
  - Indeterminate loading/execution uses a seven-point square Π (11.6×11.6 in a 16×16 viewBox)
    inside the existing square icon slot. Patterns are row/column sweeps, outline tracing,
    breathing, outward propagation, side relay and gathering. Every complete 2.4-second cycle
    independently selects the next pattern with equal probability; repeats are allowed. Rerenders
    and status-label updates neither reselect nor interrupt the current cycle. Reduced motion shows
    a static Π.
  - Sidebar working states use Π; unread completion/failure use matching linked-dot check/cross.
    Tool rows and nested calls use the same settled glyphs. Not-executed and missing-result tools,
    and cancelled/unfinished child calls, use a static eight-point perimeter with an empty center in
    `--muted`; their distinct labels stay intact, without implying work, success or failure.
  - Point cells and resting glyph footprints are square (1:1); light links keep a three-point check
    readable at 12/14px. Success/error colors and attention stay distinct, and reading still clears
    unread terminal cues.
  - Generating, queued and executing tools keep one mounted glyph and an uninterrupted cycle; tool
    status follows the name in both parent and nested rows.
  - Refresh controls show directional arrows at rest and Π while refreshing. Settings checks and
    terminal connection/initialization use Π only while work is actually pending; offline/passive
    connection markers stay static, and determinate progress is not replaced by this animation.
- Text meets WCAG AA contrast, and graphical focus/status cues meet their UI
  contrast threshold. `:focus-visible` uses the shared 2px accent outline;
  clipped headers and file-path columns keep it inside the target without growing controls,
  shifting reading boundaries, or scrolling an ancestor to reveal the ring.
  Controls keep named roles, native semantic structure, visible keyboard
  focus, and focus restoration after overlay close. Touch controls occupy real
  layout space, not overlapping pseudo-targets.

## Checks

- `tests/web/styles-contract.test.ts` checks that project CSS variable references have declarations.
- Theme bootstrap and overlay ownership have focused web tests; isolated
  browser coverage checks desktop and narrow workbench behavior, including the
  320px and 390px controls, drawer dismissal, and keyboard/accessibility paths.
- Check affected visual roles in both luminosities and every palette where they appear, using actual
  foreground/background pairs and interaction states.

## Non-goals

- Carbon & Silicon may reference the Modern themes' neutral surface colors; the system does
  not reproduce a reference application's layout, typography, artwork, or component identity.
- It does not mix botanical surface ladders, use a legacy
  mixed-case lockup, large decorative brand motifs, idle-state breathing,
  recurring completion celebration, or a second responsive component structure.
