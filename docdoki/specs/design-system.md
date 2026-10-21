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

Give INSΠRE a coherent, medium-density scientific-workbench character while
keeping conversation content dominant. `src/styles.css` is the ordered entrypoint
for responsibility-scoped modules under `src/styles/`; `foundation.css` owns the
shared tokens. This spec states the roles, values whose identity matters, and
component anatomy that must remain stable rather than duplicating every
declaration.

## Identity and palette

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
- Supporting installed desktop windows use Window Controls Overlay, with `standalone`
  as the fallback. The Overlay strip uses the theme's outer-frame / navigation color
  (`--bg-rail`), without subdivisions, a bottom rule, gradient or shadow. Its `theme-color`
  hint follows palette and resolved luminosity before first paint and after Host bootstrap,
  including system-theme and Overlay-mode changes. Ordinary tabs and standalone fallback
  retain neutral `#F4F5F6` / `#14171A` hints; the manifest retains its neutral light fallback.
  Browser/OS support owns the actual native controls and installed-icon update timing.
  A small INSΠRE wordmark centers over the whole window, constrained to the browser-reported
  safe rectangle. INS and RE use quartz-gray/silver; Π follows the theme's brand accent.
  Navigation resize and collapse do not shift it. A 16px Open Reticle shares the collapsed rail's
  icon axis when the safe area permits; otherwise it sits 12px inside the safe rectangle's left
  edge. It has no button, background or new action. Desktop Overlay navigation
  omits its duplicate brand and starts with New session beside Collapse, then search; the collapsed
  rail uses a navigation icon. Ordinary tabs and narrow drawers retain their sidebar brand/header.
  When native controls leave insufficient titlebar width, the centered wordmark yields to the
  corner icon; its optional needle toggle remains available in Settings. The brand focus ring
  stays inside the safe height, including shorter titlebars.
  The navigation divider stops below the uninterrupted strip. Wordmark colors transition over 180ms.
  The brand serves as a manual toggle for an optional Buffon's needles Easter egg
  (`app-region: no-drag`, accessible semantics and tooltip; default off). It shares the persisted
  Titlebar needles switch in Settings → Display, so refresh preserves the choice. Needles arrive individually
  at independent random intervals, not in batches. Each has a random static position and orientation,
  an independently sampled length and fade lifetime, and the active theme's Tool/Thinking identity
  colors directly through `--activity-tool` and `--activity-think`. Arrival frequency is 3.6 × (1 + busy session count) per second
  for 2400 drawable CSS pixels. Count all managed and observed native Pi sessions once per identity,
  not just the selected one.
  Waiting for input does not add to the count. Frequency scales with the full decorative titlebar
  width, with only a 2px edge inset. The background is sampled uniformly behind foreground
  controls, including the corner icon and wordmark: no control exclusion zones, safe-rectangle
  clipping, or opaque mark backplates are added. The layer never receives pointer events;
  browser-owned chrome can still paint above web content. Needle dimensions use
  CSS pixels and lifetime distributions remain unchanged across displays. Particle limits scale with
  density rather than throttling wide windows at a fixed small count. Resize and run-state changes
  retime future arrivals without clearing existing fades. No spinning or falling motion is added.
  Reduced motion, hidden documents, inactive Overlay, and toggle-off immediately clean up or suppress
  needle animations.
  An observed successful run in the selected session gives Π one 800ms glow, not a loop;
  snapshots, session switches, failures and aborts do not trigger it. Hidden pages do not replay
  completion cues on return. Reduced-motion preferences disable the glow and color transitions.
  The browser supplies the titlebar height and native window controls. Only the safe strip is
  draggable; workbench content, dialogs, drawers and focused terminals stay below it.
  Ordinary tabs, unsupported browsers and disabled Overlay reserve no custom row.
  Browser-owned chrome: [[workbench-implementation]].
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
- Components map the same semantic role across palettes: a surface using role X in one
  palette uses that palette's X in every other palette. Palettes share a broadly consistent
  design while allowing individual character; differences between the botanical and classic
  families need not be flattened. This does not require unrelated roles to have different values.
- Decorative accents and readable ink are separate roles:

  | Palette | Light accent | Light accent ink | Dark accent | Dark accent ink |
  | --- | --- | --- | --- | --- |
  | Wisteria | `#6E5494` | `#543D78` | `#B39DDB` | `#C2B0E6` |
  | Hydrangea | `#1F7A68` | `#155B4D` | `#5EC4AE` | `#74D2BE` |
  | Lycoris | `#BC5042` | `#94362A` | `#EE8474` | `#F49B8E` |
  | Chimonanthus | `#B36010` | `#8A4605` | `#EAA03E` | `#F2B25C` |
  | Jade | `#007D78` | `#005E5A` | `#52D2C9` | `#52D2C9` |
  | Amber | `#D95A00` | `#A23E00` | `#FF781F` | `#FF781F` |

  `--accent` supplies theme marks and running feedback; `--accent-deep`
  supplies readable text ink. `--accent-fill` supplies solid buttons and checked
  Settings switches, paired with `--on-accent`. Light fills use white foregrounds
  and dark fills use dark foregrounds. Solid buttons keep this pair in normal,
  hover and pressed states. Their
  `--accent-fill-hover/active` roles darken light fills or lift dark fills; decorative
  `--accent-hover/active` are not assumed safe behind small text. Error fills follow
  the same luminosity-aware state rule with `--on-status`. Disabled buttons use neutral
  roles; disabled switches retain their checked/off state with reduced opacity.
  Selected icon buttons keep their accent ink/tint through hover and press. Disabled
  icon buttons use neutral ink and the default cursor, without hover/pressed feedback;
  local action styles respect this state rather than overriding the shared control.
  Segmented choices use `--accent-deep` for selected text and accompanying icons;
  unselected options stay neutral. The shared rule covers Settings and Terminal settings,
  named palette choices, composer and prepared-prompt Steer/Queue, and resource mode choices.
  Selection also retains its surface and weight cues; hover, press and focus do not replace
  its accent ink. Disabled segments use neutral ink. This rule does not recolor arbitrary
  selected lists or semantic status indicators.
  Quiet actions retain transparent backgrounds and borders when disabled.
  Standalone actions and form variants also suppress disabled hover/pressed feedback,
  including underlines and border changes. Read-only session headings retain their readable
  text but lose the pointer cursor and action highlight. A dropdown that becomes disabled
  closes its menu without changing the selected value.
  Focus indicators consume `--accent-focus`, including local outlines, focused input
  borders and inset focus strokes. Botanical palettes map this role to `--accent`;
  classic Jade and Amber map it to `--accent-deep`. Components use the role rather
  than either underlying color. Focus does not recolor readable text, semantic error
  states or nonfocused selection markers.
  Selected sessions use `--accent-tint` through `--nav-active-bg`; the extra
  `--accent-soft` inset outline is transparent.
- Botanical surfaces carry the theme's paper temperature throughout the rail, prompt,
  activity, code and reading areas. Light stages are Wisteria `#FAF9FC`, Hydrangea
  `#FBFBF9`, Lycoris `#FCFBF9`, and Chimonanthus `#FCFBF8`; raised surfaces and
  Composer remain white. User prompts use the tinted rail family, not white cards.
  Dark stages use purple charcoal, green charcoal, warm red charcoal and warm amber
  charcoal respectively, with lighter surfaces and darker code/inset areas.
  Existing component structure remains independent of palette: activity headers are
  transparent disclosure rows, expanded Thinking uses open reading content rather than a
  full tinted card, and custom extension messages use `--bg-surface` with a boundary.
  Classic Jade and Amber retain their characteristic accents and surfaces; readability corrections
  belong to the same control/text roles as other palettes. File-preview neutrality is unchanged.
  Resting navigation search uses `--bg-control`; the topbar blends 88% `--bg-stage` with
  `--bg-rail`. Components use shared roles rather than local palette values.
- File inspection is the deliberate exception: its host-owned Preview, Source,
  and Changes canvases use the luminosity-aware `--bg-file-*` neutral ladder,
  which is identical across all supported palettes. Product chrome remains
  palette-aware, rendered artifacts retain their authored backgrounds, and
  source syntax or Diff additions/deletions retain semantic color. Syntax and Git
  text use luminosity-aware colors with AA contrast on their neutral or tinted
  reading surfaces.
- Small status text uses the corresponding `--success-ink`, `--warning-ink`,
  `--info-ink` or `--error-ink` role on neutral or tinted surfaces, including chips,
  Git change counts, copied-path text, notices, recovery banners, history and file boundaries.
  Outlined, quiet and menu danger actions use `--error-ink`
  for text, retained through hover, press and focus; disabled actions use neutral ink.
  Semantic danger borders and hover tints retain `--error`.
  Activity-fold loading failures use `--error-ink`,
  retained through hover, pressed and focus states without recoloring Tool/Thinking marks.
  Successful command badges derive `--activity-success-ink`
  from their activity status color. Status icons, borders and tints retain their status
  color; interaction overlays must not erase text contrast. Disabled solid controls,
  including Composer recovery, retain their neutral appearance on hover.
  Direct-shell output notes keep inline metadata actions at 24px for a fine pointer and 44px
  for a coarse pointer, without imposing a touch-sized line on desktop prose. This does not
  shrink the separate tool-result notice action.
  Readability checks cover actual foreground/background pairs and interaction states, not just
  standalone swatches. Faint text remains readable on its supported workbench surfaces.
- Success, warning and error remain independent status roles. Tool identity follows the
  selected theme family through a dedicated `--activity-tool` shade; Thinking has its own harmonious contrasting
  ink, with matching tint, in every palette/luminosity. Neither identity changes on failure.
  Context-event icons (including Pi and Magic Context), extension-message glyphs (including
  Intercom), and the ongoing compaction indicator use `--activity-event`, an identity alias of
  the current palette's `--activity-tool`. Compact progress text uses the corresponding
  `--activity-event-ink` on its tint; context and extension glyphs keep the unmixed identity color.
  This does not make extension messages tool executions:
  their icons, attribution, surfaces and disclosure behavior remain distinct. Ordinary information
  notices and command outcomes retain `--info`/`--info-ink`; success, warning and error keep their
  outcome roles rather than inheriting the activity identity.
  The PWA needle animation shares these same Tool/Thinking colors, including on live theme changes.
  Error/Stop uses raspberry-red rather than Lycoris's decorative red. Light semantic ink is deeper
  than decorative accent fills; dark semantic ink is lifted for readability. Navigation state combines its positioned status mark
  and accessible state with color: working uses Π in the warning role,
  completion uses success, failure uses error, and recovery remains visibly
  distinct. Color alone never carries a product state.

## Neutral stroke colors

- `--line` supplies ordinary structural dividers and resting boundaries. `--line-strong`
  supplies emphasized neutral edges, including stronger control boundaries and hover states.
  Both are colors, not widths; components specify their stroke width separately. Classic
  Jade and Amber retain ink-with-transparency strokes rather than botanical slate colors.
- `--hairline` and `--hairline-strong` are single aliases of those roles, not independent
  palette values. Every supported palette/luminosity combination resolves each alias to its
  canonical color.
- Botanical strokes follow their paper temperature: light Wisteria `#DAD6E4`,
  Hydrangea `#D6DDD4`, Lycoris `#E0D6D2`, Chimonanthus `#DFDAD0`, with individually
  tinted dark counterparts. `--line-subtle` aliases `--line`; `--line-strong` supplies
  stronger boundaries. These are resting boundaries, not substitutes for accent focus or semantic status.
  Components select the ordinary or strong role by purpose, without local dark-mode color patches.

## Type, geometry, and spatial hierarchy

- IBM Plex Sans SC owns interface controls, reading text, Chinese/Latin flow,
  and the wordmark. Flux Mono SC owns code, paths, identifiers, timestamps,
  shortcut labels, and machine-oriented data. Rajdhani owns structural labels: Activity group
  headers, resource mode tabs, Settings section headings and model-list section labels. Its local
  Latin 500/600 faces (about 31KB combined, SIL OFL) use `--font-label`, with Sans SC for other
  scripts. Ordinary controls, item identities and prose keep Sans SC; upper/lower Activity
  boundaries and Earlier activity share the structural face.
  KaTeX keeps its bundled glyphs.
  The render-blocking stylesheet registers the exact Latin core faces; the
  complete checksum-pinned CJK face registry is a deferred stylesheet loaded
  only after authoritative bootstrap settles, so its large declarations cannot
  delay first render or compete with bootstrap while the browser still fetches
  only the Unicode subsets actually used.
- The shared type scale is 11.5px, 12.5px, 14px, 15.5px, 17px, 21px, 26px, and
  32px; 600 is the maximum product weight. CJK running text has no tracking,
  while short uppercase Latin labels may use restrained tracking. Compact,
  Comfortable, and Large content presets remap only conversation prose,
  headings, code, reasoning, tables, composer drafts, and text previews across
  this scale; interface controls keep their fixed tiers.
  Structural Rajdhani labels use 500 weight (600 for selected resource tabs), uppercase Latin
  and restrained tracking. Resource tabs use four equal-width columns, with compact 13px labels;
  the smallest groups use the untracked 12.5px tier. Selected and unselected names fit without
  cropping or distorted letterforms. Count capsules use `--accent-tint`/`--accent-deep` with
  smaller text on the label baseline and a distinct gap from the name.
  Groups too narrow for the complete label and count omit the optional count but retain the
  exact Changes count in its title. Desktop tabs are 28px tall; compact touch tabs are 34px tall,
  with adjacent 32px actions. Settings section
  icons remain outside the font-dependent heading line box. Activity matrices/disclosure arrows
  and Settings section icons align with the visible uppercase letters, not merely the line-box center.
  A wrapped Settings heading keeps its icon beside the first line; its action stays independent
  of the icon/title group rather than centering the icon between multiple lines.
  Navigation, file subsection headings, command-palette and completion/model-choice headings
  preserve authored casing and their established UI tiers. Technical identifiers retain their
  exact spelling; document typography is unchanged.
  Dialog titles, prose, and deletion errors wrap long literal paths or identifiers within their
  shared content edges instead of overflowing the frame. Settings status and Host availability
  explanations likewise stay within their own text columns. Field widths, action geometry, and the
  original payload text remain unchanged.
- The 4px spacing scale is the only general rhythm. Shared geometry uses
  2px inline corners, 6px controls, 10px resting surfaces, and 12px overlays.
  `999px` is reserved for genuinely round/capsule affordances such as status
  geometry, scroll thumbs and thin resize strokes, not ordinary cards or inputs.
  Inset menu highlights and compact file/search/terminal toolbar actions use the control radius;
  the virtual model list has horizontal highlight insets without changing row heights/offsets.
  PDF Fit shares neighboring toolbar-button geometry. Keyboard focus follows a control's silhouette:
  terminal tabs keep rounded upper corners and a square join to their content. Settings selection
  markers have the same thin round-ended treatment as navigation, including the narrow underline.
  Nested segment radii account for parent padding and borders rather than copying the outer radius.
  Settings headings sit outside independent bordered content cards, instead of forming tinted
  banners. General and Terminal settings share content and shell insets across viewport sizes;
  neighboring segmented-choice rows use the same stacked layout inside narrow Terminal cards.
  In narrow model settings, group labels align with model names and empty default values use
  their text width rather than reserving an absent dropdown's width.
  Both section and card keep overflow visible for menus and focus. Provider header fills
  still use the outer radius minus the border thickness to keep their curves concentric.
- Neutral surface steps, hairlines, and whitespace express depth. Resting
  surfaces avoid theatrical shadow; the reading stage is a content field, not one giant card.
  Shared elevation combines a small contact shadow with a softer ambient shadow:
  `--shadow-1` stays faint on small resting surfaces (and absent in dark mode);
  `--shadow-2` lifts menus and notices in light and classic dark palettes; botanical dark
  palettes use borders and surface contrast instead. `--shadow-overlay` separates dialogs and drawers.
  The Composer stays integrated with the workspace: no resting shadow,
  a crisp focus boundary with a faint close ring, and no separate floating-island shadow,
  while its running/retry/compaction/error treatments retain ownership of state feedback.
  Shadows supplement existing borders rather than adding a second outline; they do not
  add elevation to the reading stage, navigation or contextual pane shells.
- Desktop is a three-region workbench. Automatic widths use 220–272px for navigation
  (48px collapsed) and 340–760px for context; manual resizing and their shared width budget
  follow [[workspace-layout]]. The centered reading/composer field offers Narrow 680px,
  Comfortable 820px, and Wide 980px measures, bounded by the available center region.
  The 44px topbar aligns the regions without
  turning the page into a dashboard of boxed panels. Connecting/reconnecting is a quiet, unboxed
  transport hint, not an action button; compact headers retain its accessible label. Offline and
  Host failures keep warning treatment, and the hint disappears when the connection recovers.

## Scrolling

Native scroll areas share a transparent track and a rounded, neutral thumb with stronger hover and
pressed states. Settings, pickers, History, Files/Changes, document previews and horizontal code
scrolling inherit this treatment. Chromium/WebKit use an 8px track with a 6px visible thumb and no
arrow buttons; Firefox uses its native thin geometry. High-contrast mode retains system colors.

Terminal's own slider uses the same color roles and visible thickness while retaining its drag target
and scroll handling. Navigation/conversation boundary rails and deliberately hidden tab-strip bars
keep their existing behavior. Embedded documents retain their own styles.

## Component grammar

- Shared pane states use an unfilled 36px icon slot, title weight 500 and the existing
  secondary hint typography. Empty, loading and unavailable states retain their spacing,
  semantic roles and actions. Compact directory-list messages keep their own layout.
- Compact list/search empty states use the base stack: 24px 16px padding, 4px gap and
  a `--text-sm` title at weight 500. Conversation emptiness uses the explicit
  `empty-state--conversation` variant: 64px vertical padding, 8px gap and a `--text-xl`
  title at weight 500. Its rules do not leak into Navigation or Command Palette.
  Terminal empty titles also use weight 500, retaining terminal colors, icons and actions.
- Git change-group counts use ordinary secondary monospace text at weight 400, without
  a capsule background. Keep their existing size, padding, colors and count semantics;
  Git status marks and the repository summary retain their separate roles.

- The navigation header carries a non-interactive optical reticle and wordmark with a separate
  collapse button at the right. New session is a quiet, full-width control row above search,
  using the shared control radius and neutral hover fill, with no resting box, shadow or command badge.
  The header has no horizontal divider above these controls.
  New session and session search share row height, font size, a 16px icon slot and label baseline;
  the creation label stays slightly heavier while its plus icon uses neutral rather than brand color.
  Give the creation/search rows an 8px gap and leave 16px below search before the project list.
  The desktop Overlay header applies the same breathing room without changing its titlebar alignment.
  The collapse control uses the plain sidebar-outline icon, matching the panel-toggle family.
  On the desktop rail the mark expands navigation; a separate plus control sits below it.
  Expanded and rail logos share the same size and primary icon axis. New session, search, group
  and session labels share a text axis; counts/ages share their right column. Hidden folders add
  one indentation step, while the workspace tree retains its own nested hierarchy. On narrow or
  coarse-pointer layouts, the wide creation/search rows use a compact 36px height and 14px label
  tier; icon-only rail and close controls retain 44px targets. WebKit keeps 16px search editing
  text to avoid focus zoom, with the resting prompt at the compact label tier.
  Resting session search retains a distinct input surface with a fine hairline boundary;
  hover strengthens that boundary and focus restores a surface fill with accent border.
  Session, conversation and workspace search share muted icons/placeholders and ink-colored input;
  hover strengthens icons and focus uses an accent border. Conversation and workspace search retain
  opaque surface fills and fine resting borders rather than copying the navigation's inset fill.
  Selected sessions use a translucent lifted surface; collapsed folders containing the selection
  keep a quiet accent tint. Both have an inset, straight round-ended accent marker; ordinary hover
  remains neutral. The outer session row owns its selection fill, including while its select
  button is disabled. Folder headings and rows share the control
  radius, with the folder's keyboard outline inside its clipping boundary.
  Full-width Workspace and Hidden dock headers also keep their keyboard outlines inset,
  so window and drawer edges do not clip the feedback; their geometry and actions stay stable.
  Folder icons leave a clear gutter beside the inset selection marker; folder names and their
  session names retain a common text axis, including inside Hidden.
  Existing catalog side insets, session row heights and project separation remain. Adjacent
  project groups use a 16px section margin on top of the 2px catalog gap, with a 20px margin
  after pinned sessions or the last pinned folder; closing a folder does not compress this rhythm.
  Hidden retains its compact drawer spacing, independent of a hidden folder's previous pin.
  Project/session hierarchy, curation and runtime state remain legible without duplicating a
  session into a separate status group.
- User messages form right-aligned, content-sized bubbles with 14px corners, a neutral border and
  no accent edge. Copy/Fork form a compact horizontal group to the bubble's left when its existing
  spare space fits the group plus an 8px gap. Their targets align with the bubble's lower edge,
  while the glyphs remain centered and inset within their targets. The same rule applies to short,
  long and image-only bubbles. If the group does not fit, it wraps below at the same right edge
  with a 4px gap. Buttons do not shrink the bubble or change its
  text wrapping; short, long and image-bearing messages use the same content-driven rule.
  These secondary controls keep 13px glyphs, 24px mouse targets and 32px narrow/touch targets with a
  4px gap; hover/focus reveals them and touch keeps them visible.
  Long content and attachments remain bounded. Icon-only controls remove native button padding
  and keep their SVGs from shrinking: the declared square glyph stays centered without changing
  the control hit area. This includes compact content actions, catalog actions and search navigation.
  Uploaded and sent file tags reuse the file-category icons from the workspace tree, Changes and
  file pickers; unknown types keep the neutral document fallback. Images retain their thumbnails.
  Assistant prose is an open document flow. Thinking/tool activity,
  extension-authored context messages, code, tables, math, notices, and the
  composer each use a compact structure with shared surfaces, borders, type, and
  semantic roles. [[activity-presentation]] owns activity guides, disclosure axes, header/Copy
  placement, density and reading rhythm. Activity and context events share the leading disclosure
  axis. Context events use the shared
  transcript-row gap without an extra outer vertical inset. Expanded reading text aligns with
  its header title. Context-event titles keep their intrinsic width; metrics stay adjacent when
  they fit, otherwise wrap to the title's text axis instead of compressing the title or reserving
  an extra inline indent. Mixed-size titles and metrics share a text baseline; a trailing Copy
  remains vertically centered independently of its touch target.
  Hover strengthens ink without a full-row fill; keyboard focus marks the row with a rounded
  outline. Displayed custom messages use a quiet bordered neutral surface without a colored edge,
  a package/type header, directly readable Markdown, and separately folded Details when present.
  Configured messages
  put attribution first and use a subdued source label on the same baseline; header text, body, and
  Details share a reading anchor, with Copy in a separate column. They do not inherit tool status or
  activity density. Pi errors retain a compact neutral surface with a subtle error border,
  semantic label and directly readable reason; expanded diagnostic text uses a bounded inset surface.
  Compact error, extension, and shell headers accommodate touch Copy targets within their existing
  padding rather than growing the text row. Each shell section owns its inset without a second gap
  from the generic turn layout. Pending previews center Copy on the first line while keeping wrapped
  text's top and bottom padding balanced.
- The composer is a single reading-width instrument with attachment/reference
  work above the writing field and a quiet metadata toolbar below. Model,
  thinking, project files, attachments, context usage, and send/abort stay
  aligned to that toolbar. On phones, model and thinking share the first row;
  at widths up to 420px they remain adjacent with an 8px token gap, reserving Thinking's full width
  and letting Model shrink without filling spare space. File tools, context, and send/abort use the
  second row; Send stays rightmost, with the filled error-color Stop immediately to its left
  when both are present. DOM/tab order follows that visual order. This keeps selectors usable
  with long values or busy-state controls. A constrained model label truncates
  inside its trigger rather than painting across adjacent controls. Completion
  titles wrap within their column, leaving adjacent path hints visible. Model
  status badges and their selected-row backgrounds preserve AA text contrast across supported palettes and
  luminosity modes. The detailed input, delivery, and ownership contract lives
  in [[composer]].
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
- Feedback expires by meaning, not by Info tint alone. Session & usage has a 30-second reading
  dwell; bare Name and Quit guidance have 15 seconds; ordinary INFO confirmations have 8 seconds.
  Notice Copy/dismiss use 24px mouse or 32px touch targets; touch targets borrow from the existing
  inset instead of stretching the header. A wrapped notice title keeps the icon and actions aligned
  with its first line; body text starts at the title text after its icon column. Non-modal notices
  sit below active modal dialogs rather than covering their content or controls.
  Navigation and resource drawers also own modal interaction on narrow layouts: notices sit
  below the drawers and any scrim, retaining their contents and returning to the normal layer
  on dismissal.
  Bound the stack below the workspace header/current banners and above the bottom safe inset.
  Only an overflowing stack scrolls, without compressing cards or discarding diagnostic text;
  fitting stacks retain their normal width, shadows and placement. Additional notices preserve
  an existing reading position. Copy, dismiss and keyboard scrolling remain reachable.
  Exact repeated notices coalesce in place and renew their dwell. Hover, focus within, an active
  pointer press and a hidden document pause the clock; resuming keeps the remaining time with
  at least 3 seconds to finish reading. Expiry uses only a standard 150ms opacity fade, omitted
  for reduced motion. Manual dismissal remains immediate. Errors, warnings, export actions and
  update availability do not expire on these timers. State-owned progress, extension widgets and
  retained transcript content keep their own lifecycles. [[composer]] owns query/session boundaries
  and command outcome handling.
- Supporting input stays quieter than conversation prose: attachment file chips put filenames and
  state ahead of technical metadata. Pending deliberately dims at rest and gains full emphasis on
  hover or focus within; preserve this attention hierarchy while simplifying repeated labels/counts.
  [[composer]] owns its visual states, bounded-summary and action semantics.
- Notebook execution prompts share one intrinsic gutter across cells and outputs. Retain the
  existing desktop/narrow minimums and first-source-line baseline; wider counts grow the shared
  gutter instead of painting over source. Unusually long prompts wrap within a bounded text width.
- Files, Changes, History, and Terminal share the contextual pane. Resource
  safety and change semantics belong to [[resource-preview]]; branch behavior
  belongs to [[session-branches]].
- `ResourcePathLabel` owns semantic path presentation throughout the product. It retains one exact
  value, separating parent and filename only for CSS layout. A fitting path stays complete; actual
  container overflow elides the parent before the filename, without breakpoint or percentage quotas.
  It keeps no parallel measured/reconstructed identity. Assistive text, tooltip, copy and navigation
  retain the exact value. Ordinary titles and bare filenames use their existing text treatment.
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
- Command Palette groups use compact overline headings, neutral bottom rules and indented rows,
  without full-width shaded bands. Default groups distinguish `Actions`, `Workspace` and `Sessions`.
  Long titles use up to two lines; project/age metadata stays secondary and moves below titles on
  narrow screens. Omit redundant action descriptions without removing useful search aliases.
  The accent-tinted candidate remains the action highlight; shortcut hints stay separate.
- Command Palette, Settings, extension dialogs, pickers, and destructive
  confirmation use the shared overlay grammar: the overlay radius, hairline,
  elevated shadow, restrained scrim with a 2px backdrop blur, and a short
  0.97→1 pop-in. Modal focus/keyboard ownership is behaviorally centralized in
  `useModalFocus`; a visual overlay never leaves shell shortcuts active below
  it. An incoming extension question suspends Settings without discarding its selected page,
  project owner or unsaved forms. Its subordinate confirmations also yield while the question
  owns focus, then resume without implicitly saving configuration or restarting the Host.
  Anchored menus inside filtered overlays convert viewport measurements into the
  overlay's fixed-position coordinates, accounting for its scroll offset and reserved
  window chrome without changing the trigger gap. Settings update checks use the same section/card geometry as preferences, with compact rows
  for Pi, Extensions, and INSΠRE. The update-check button reserves its longest state label so
  submission, checking, and repeat-check feedback do not shift its width or neighboring actions.
  Settings and Terminal settings categories show one page at a time
  within their dialog frame, with fixed navigation and utility footer. Both use the same safe-area-aware
  narrow frame. Narrow category selection uses one accent underline without a selected card fill,
  border or shadow; keyboard focus keeps the shared outline.

- Deferred Settings and Context keep one shell and focus owner through loading, ready, and failure.
  Content loads in the background while the shell remains interactive. Loading visuals appear only
  after 250ms, without delaying ready content or errors; reduced motion shows them immediately.
  Settings preserves its columns/navigation strip, card geometry, and footer with inert skeletons.
  Context and History reuse `ContextPaneState` for centered status and recovery actions. Skeletons
  stay outside the accessibility tree and tab order; loading has a concise status, and failure an
  alert and styled recovery action. The Pi release-note dialog also reuses this centered state
  presentation: loading Π, unavailable title with the actual error as a secondary hint, and
  quiet Retry. State content owns its padding; the normal document and shortcut-help body retain
  their existing layout. The generic unavailable message is not repeated as a hint.

## Native choice controls

Ordinary checkbox and radio inputs opt into the shared `choice-input` skin: 14px controls, strong
neutral borders and control surfaces when unchecked, then accent tint with a check or dot when checked.
Checkboxes remain square and radios circular. Models Common/Default, model/provider declaration forms,
History Carry branch summary and Export format use this same rule. Native labels, grouping, keyboard
operation and disabled semantics remain authoritative; no wrapper replaces the inputs.

Keyboard focus uses the shared accent outline. Models owns focus and disabled fading on the whole
choice label, so its input has no second outline or opacity reduction. Other disabled choice inputs
use one opacity reduction. Forced-colors mode restores native appearance and removes the custom marker.
Settings switches do not opt into this skin. Markdown task markers in conversation, file and Notebook
readers share it while retaining their 13px size, document margins and original -0.15em vertical
alignment. Check/dot markers are absolutely centered inside each input, outside inline baseline
calculation; checked state must not change box position or line height. They remain
disabled/noninteractive but keep opacity 1: a recorded task state is not an unavailable form action.

## Model-list hierarchy

The shared model picker uses transparent provider/group headings with a thin bottom rule for distinct groups,
retaining heading typography, spacing and 28px virtual-row height. Long headings stay on one
ellipsized line; the title and accessible group label retain the full provider name. The bottom rule
uses the shared ordinary stroke in both luminosities; no picker-specific dark-mode override is needed.
Settings' provider headings
already use transparent surfaces and retain their existing typography. Recent, Router and
No thinking labels use muted, normal-weight text without a filled badge, retaining their placement
and padding. Model identity, match emphasis, row heights, selection marks and Settings choices
are unchanged.

## Session and command search presentation

Native search-clear glyphs use the field's theme ink and a consistent cross; clear and Escape
semantics remain owned by each field. Workspace search keeps its explicit clear/loading control,
without a second native clear button.

Session titles and visible project names/context emphasize matching text at weight 600, without
changing colors, backgrounds, ellipsis or direct Pin/Hide controls. Plain tokens follow Pi's greedy
subsequence matching (including its letter/digit swap); quoted phrases preserve native whitespace
normalization. Regex queries retain native worker filtering without browser-side regex execution
or match emphasis. Matches in hidden search fields do not require a visible hit.

Command Palette emphasizes visible title matches at weight 600 and secondary hint matches at
weight 500. Hints retain their secondary color, size and placement; aliases and cross-field matches
remain search inputs without requiring invented visible text. Ranking, search-time Results grouping,
shortcuts, focus and keyboard selection remain unchanged. Its category headings stay transparent with a shared `--line` bottom
rule; the rule replaces one pixel of bottom padding, preserving heading height and text position.

## Extension question choices

Immediate-submit choices distinguish current keyboard focus and pointer hover without a check
that implies an answer has already been submitted. Focus retains a visible accent outline;
hover and press use the raised neutral surface with a fine neutral inset boundary so they remain
distinct from the recessed list in light and dark themes. Click/Enter submission and roving
keyboard navigation remain unchanged.

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

Code-block Copy and Insert in terminal remain compact 24px controls on mouse layouts.
Coarse-pointer layouts use separate 36px targets with an 8px gap, without enlarging their glyphs
or sharing a hit area. Their 13px square glyphs remain centered and do not shrink into browser-default
button padding. Keyboard focus rings stay inside these targets rather than clipping against the
compact header or crossing its separator. Hover feedback is mouse-only; touch has local pressed feedback.

Copy, Fork, Pending Return/Clear and similar actions share three presentation types:

1. **Constant:** visible, with unchanged visibility and opacity across activation conditions.
2. **Emphasized:** visible and semi-transparent at rest; a specified condition reduces transparency,
   possibly to full opacity.
3. **Revealed:** absent visually at rest; a specified condition makes the action visible, possibly
   still semi-transparent.

The implemented message/content action assignments are:

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
On devices without hover they are visible at 0.75 opacity by default; focus still reveals them fully. The existing message-footer
touch default of 0.75 is preserved. Icon colors retain their surface roles: full opacity does not
replace the deliberately subdued glyph color.

Pending retains its independently decided panel-level idle dimming, transparent background and
quiet border. All its actions stay locally opaque and inherit the panel's 0.75-to-1 emphasis; do not
add a second opacity layer to individual buttons. Content roles and disclosure structure remain unchanged; content copying and source ownership
follow the shared semantics above. [[conversation]] and [[composer]] own their behavior.

Project-wide quiet buttons assign presentation by a control's role,
not its label alone. `.button--quiet` uses constant presentation: enabled text buttons keep body-color
text and a transparent resting fill/border; transparent borders retain layout space. Hover and press
use standard inset/control surfaces without a visible border. Shared keyboard focus and disabled
styling remain.

- Subordinate exit/navigation actions use quiet: form and pre-execution confirmation Cancel,
  Command Palette Back, and Dismiss after a login attempt ends. Existing compact navigation links
  and icon-close controls retain their already-unframed variants.
- Content loading/preview recovery uses quiet across History, Files/Changes, Models/provider
  loading, Command Help, deferred Settings/context views and Terminal settings. Host status
  rechecking is also quiet; retrying a restart request remains an execution action.
- Existing History pagination/Fork/Clone, earlier-branch Clone and directory-root shortcuts remain
  quiet. Root shortcuts retain compact mono typography and geometry.
- Primary or preferred execution/navigation stays emphasized: Save/Submit, add/reset controls,
  branch continuation and the earlier-branch banner's Back to latest. Actual response choices
  (Pi Yes/No, login methods/options), pending Cancel login and dangerous execution retain their
  ordinary/primary/danger variants. A label such as Back or Retry does not override that role.

Files/Changes compact recovery buttons share quiet surfaces while retaining their existing sizing.
The directory
picker's editable path uses the same canvas fill, line border, small radius and inset accent focus
mark as Welcome's directory field, with mono text, soft wrapping and content-sized height at the
current viewport width. It remains above
the bordered directory list. Welcome's editable directory input is unchanged.
These secondary actions stay directly available; quiet styling changes presentation, not event handling,
keyboard order, focus ownership or operation guards.

Content availability is a capability concern, not a fourth presentation type. Copy behavior follows
[Content copying](#content-copying) above.

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
  probability; repeats are allowed. An outer CSS animation clock ignores staggered child events,
  so ordinary rerenders or status-label updates neither reselect nor interrupt the current cycle.
  This is animation-cycle selection, not one fixed pattern for an entire run.
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
  [[composer]] owns its running halo and static state feedback. Short card/palette entrance and disclosure transforms
  are permitted. Reduced motion removes nonessential animation and collapses transitions to a
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
- A visual change is evaluated in both luminosity modes and all supported palettes when
  its affected role appears in each; it does not create a second component
  architecture or a local exception token.

## Non-goals

- The system does not reproduce a reference application's palette, typography,
  artwork, or component identity.
- It does not mix botanical surface ladders, use a legacy
  mixed-case lockup, large decorative brand motifs, idle-state breathing,
  recurring completion celebration, or a second responsive component structure.
