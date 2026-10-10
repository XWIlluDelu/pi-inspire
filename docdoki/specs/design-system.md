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
  - scripts/import-ibm-plex-sans-sc.mjs
  - scripts/verify-release-package.mjs
  - server/preferences.ts
  - shared/contracts.ts
  - src/**/*.tsx
  - tests/web/styles-contract.test.ts
  - tests/web/app.test.tsx
  - tests/web/overlay-and-palette.test.tsx
  - tests/web/theme-init.test.ts
  - tests/browser/workbench.spec.ts
  - tests/browser/loading-states.spec.ts
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
  is a pixel-fitted optical master. Launcher assets place the mark on a carbon
  tile: ordinary PWA icons scale the complete tile and mark to 81.25% of the
  canvas, leaving a 9.375% transparent inset on each side (48px on the 512px
  master). This keeps launcher size comparable to neighboring desktop icons
  and avoids white corner wedges. Maskable and Apple touch assets use the
  full-bleed carbon master and rely on the operating system's own mask.
  Installed icons are palette-independent: carbon `#14171A`, titanium-white
  brackets `#F4F6F8`, and silver ticks/aperture `#B9C0C7`.
  The transparent browser-tab favicon is also palette-independent: it keeps its
  pixel geometry and ink/white brackets, with neutral quartz-gray `#63676C` ticks
  in light browser chrome and silver `#B9C0C7` ticks in dark browser chrome.
  It adds no background or opacity change. In-app identity retains its accents.
- Installed-window chrome uses neutral `#F4F5F6` in light mode and `#14171A`
  in dark mode, identical across Amber and Jade. The page's `theme-color`
  follows resolved luminosity before first paint and after Host bootstrap,
  including system-theme changes; the manifest uses the neutral light fallback.
  Browser/OS support owns the actual chrome rendering and installed-icon update
  timing, not the page. Implementation and verification: [[neutral-pwa-chrome]].
- Palette and luminosity are independent. **Amber** (琥珀) is the default and
  persists as `amber`; **Jade** (青玉) is the optional alternative and retains
  the compatibility identifier `teal`. Light, Dark, and System select
  luminosity independently of either palette.
- Amber's identity accent is `#D95A00` in light and `#FF781F` in dark. Jade's
  is `#007D78` in light and `#52D2C9` in dark. A browser-local visual cache may
  paint a saved theme/palette before React starts, but host preferences remain
  authoritative after bootstrap.
- Each palette supplies distinct canvas, rail/navigation, context, reading
  stage, surface, inset/control, activity, and code roles. Amber uses warm
  paper/carbon neutrals; Jade uses its own cool neutral ladder. Components use
  roles such as `--bg-surface`, `--hairline`, `--accent`, `--accent-fill`, and
  `--accent-tint`, never locally invented palette values.
- File inspection is the deliberate exception: its host-owned Preview, Source,
  and Changes canvases use the luminosity-aware `--bg-file-*` neutral ladder,
  which is identical across Amber and Jade. Product chrome remains
  palette-aware, rendered artifacts retain their authored backgrounds, and
  source syntax or Diff additions/deletions retain semantic color. Syntax and Git
  text use luminosity-aware colors with AA contrast on their neutral or tinted
  reading surfaces.
- Success, warning, error, tool-info, and thinking-violet are semantic roles,
  not alternate brands. Navigation state combines its positioned status mark
  and accessible state with color: working spins in the warning role,
  completion uses success, failure uses error, and recovery remains visibly
  distinct. Color alone never carries a product state.

## Neutral stroke colors

- `--line` supplies ordinary structural dividers and resting boundaries. `--line-strong`
  supplies emphasized neutral edges, including stronger control boundaries and hover states.
  Both are colors, not widths; components specify their stroke width separately.
- `--hairline` and `--hairline-strong` are single aliases of those roles, not independent
  palette values. All four palette/luminosity combinations resolve each alias to its canonical color.
- Ordinary strokes remain quiet but visible on neutral surfaces, including raised menus/dialogs.
  Dark Amber uses `#303742` and dark Jade `#303A34`; light ordinary strokes retain their existing
  palette colors. Strong strokes retain each palette’s own values; Jade does not inherit Amber’s.
  Components select the ordinary or strong role by purpose, without local dark-mode color patches.

## Type, geometry, and spatial hierarchy

- IBM Plex Sans SC owns interface controls, reading text, Chinese/Latin flow,
  and the wordmark. Flux Mono SC owns code, paths, identifiers, timestamps,
  shortcut labels, and machine-oriented data. KaTeX keeps its bundled glyphs.
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
- The 4px spacing scale is the only general rhythm. Geometry is intentionally
  precise: 2px inline corners, 3px controls, 4px resting surfaces, and 6px
  overlays. `999px` is reserved for genuinely round/capsule affordances such
  as status geometry and scroll thumbs, not ordinary cards or inputs.
- Neutral surface steps, hairlines, and whitespace express depth. Resting
  surfaces avoid theatrical shadow; raised menus, notices, and dialogs use
  the shared shadow roles. The reading stage is a content field, not one giant
  card.
- Desktop is a three-region workbench: a 220–272px navigation column (48px
  collapsed rail), a centered reading/composer field with Narrow 680px,
  Comfortable 820px, and Wide 980px measures, and a contextual pane clamped
  from 340px to 760px. Responsive caps and the available center region still
  bound every selected measure. The 52px topbar aligns the regions without
  turning the page into a dashboard of boxed panels.

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

- The navigation header carries the optical reticle and wordmark; the collapsed
  rail carries only the mark. A selected session uses a restrained accent edge
  and tint, while project/session hierarchy, curation, and runtime state remain
  legible without duplicating a session into a separate status group.
- Assistant prose is an open document flow. User turns, thinking/tool activity,
  extension-authored context messages, code, tables, math, notices, and the
  composer each use a compact structure with shared surfaces, borders, type, and
  semantic roles. Activity cards communicate kind and outcome through both
  iconography and their bounded semantic edge. Displayed custom messages instead
  use a neutral message surface with an information-blue edge, a package/type
  header, directly readable Markdown, and separately folded Details when present. Configured messages
  put attribution first and use a subdued source label on the same baseline; header text, body, and
  Details share a reading anchor, with Copy in a separate column. They do not inherit tool status or
  activity density. PI error retains its
  existing red-edge surface.
- The composer is a single reading-width instrument with attachment/reference
  work above the writing field and a quiet metadata toolbar below. Model,
  thinking, project files, attachments, context usage, and send/abort stay
  aligned to that toolbar. On phones, model and thinking share the first row;
  at widths up to 420px they remain adjacent with an 8px token gap, reserving Thinking's full width
  and letting Model shrink without filling spare space. File tools, context, and send/abort use the
  second row; Stop retains its filled error-color treatment. This keeps selectors usable
  with long values or busy-state controls. A constrained model label truncates
  inside its trigger rather than painting across adjacent controls. Completion
  titles wrap within their column, leaving adjacent path hints visible. Model
  status badges and their selected-row backgrounds preserve AA text contrast across both palettes and
  luminosity modes. The detailed input, delivery, and ownership contract lives
  in [[composer]].
- Supporting input stays quieter than conversation prose: attachment file chips put filenames and
  state ahead of technical metadata. Pending deliberately dims at rest and gains full emphasis on
  hover or focus within; preserve this attention hierarchy while simplifying repeated labels/counts.
  [[composer]] owns its visual states, bounded-summary and action semantics.
- Files, Changes, History, and Terminal share the contextual pane. Resource
  safety and change semantics belong to [[resource-preview]]; branch behavior
  belongs to [[session-continuity]].
- `ResourcePathLabel` owns semantic path presentation throughout the product. It retains one exact
  value, separating parent and filename only for CSS layout. A fitting path stays complete; actual
  container overflow elides the parent before the filename, without breakpoint or percentage quotas.
  It keeps no parallel measured/reconstructed identity. Assistive text, tooltip, copy and navigation
  retain the exact value. Ordinary titles and bare filenames use their existing text treatment.
- Compact Plex labels share a 1px optical adjustment in buttons, segmented controls, dropdown
  values, section titles, and custom-message attribution. Button height and icon geometry stay
  unchanged; prose and mixed-font field descriptions retain their normal line boxes. Custom-message
  icons and Copy center against the attribution group, including when the sender wraps.
- Searchable menus use the same accent tint for pointer hover and keyboard candidates. Pointer
  movement and arrow navigation select one highlight mode; leaving a row removes its hover without
  dismissing the panel or blurring its search field. Checkmarks and `aria-selected` identify committed
  values independently of that candidate highlight. Settings model search stays neutral until keyboard
  navigation or an explicit row action.
- Command Palette group headings use the existing muted semibold type and spacing without
  full-width shaded bands. A shared neutral bottom rule distinguishes groups. Labels guide scanning; the accent-tinted command candidate
  remains the action highlight, and shortcut hints remain separate. Input and overlay boundaries stay
  intact.
- Command Palette, Settings, extension dialogs, pickers, and destructive
  confirmation use the shared overlay grammar: a 6px surface, hairline,
  elevated shadow, restrained scrim with a 2px backdrop blur, and a short
  0.97→1 pop-in. Modal focus/keyboard ownership is behaviorally centralized in
  `useModalFocus`; a visual overlay never leaves shell shortcuts active below
  it. Settings update checks use the same section/card geometry as preferences, with compact rows
  for Pi, Extensions, and INSΠRE. Settings and Terminal settings categories show one page at a time
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
  presentation: loading spinner, unavailable title with the actual error as a secondary hint, and
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

## Model-list hierarchy trial

The shared model picker uses transparent provider/group headings with a thin bottom rule for distinct groups,
retaining heading typography, spacing and 28px virtual-row height. The bottom rule uses the shared
ordinary stroke in both luminosities; no picker-specific dark-mode override is needed.
Settings' provider headings
already use transparent surfaces and retain their existing typography. Recent, Router and
No thinking labels use muted, normal-weight text without a filled badge, retaining their placement
and padding. Model identity, match emphasis, row heights, selection marks and Settings choices
are unchanged. This is an approved visual trial awaiting review.

## Session and command search presentation

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

## Searchable-surface focus

On primary touch/no-hover devices, opening the model picker, Command Palette or project-file
picker focuses its non-editable list/panel rather than the search field. Search starts when the
user taps the field; opening a chooser must not summon the software keyboard. Desktop retains
search autofocus, including in narrow windows. Explicit text actions such as Rename and prepared
command editing still focus their input. Returning to the palette list follows the same device
rule. Modal containment, nested portals, keyboard navigation and opener restoration remain intact;
result updates and viewport resizing must not steal focus from a field the user has entered.

## Action-button presentation

Copy, Fork, Pending Return/Clear and similar actions share three presentation types:

1. **Constant:** visible, with unchanged visibility and opacity across activation conditions.
2. **Emphasized:** visible and semi-transparent at rest; a specified condition reduces transparency,
   possibly to full opacity.
3. **Revealed:** absent visually at rest; a specified condition makes the action visible, possibly
   still semi-transparent.

The implemented message/content action assignments are:

| Surface | Type | Activation |
| --- | --- | --- |
| User-message Copy and adjacent Fork | Revealed | Hover or focus within the whole message |
| Tool, Thinking and CodeMode header Copy | Revealed | Hover or focus within that card's header |
| Branch/compaction summary Copy | Revealed | Hover or focus in the disclosure header or its independent Copy control, including while collapsed |
| Displayed custom-message Copy | Revealed | Hover or focus within the message header |
| Extension text-widget Copy | Revealed | Hover or focus within the whole widget |
| Assistant-response footer Copy | Emphasized | Whole-message hover/focus changes desktop opacity from 0.50 to 1 |
| All Pending Copy, Return and Clear controls | Emphasized | Whole-panel hover/focus changes effective opacity from 0.75 to 1 |
| System error/update information, code blocks, direct Shell results, file/project paths and Terminal text-reader Copy | Constant | Visibility and opacity stay unchanged |

Revealed actions retain their layout space and keyboard access. On devices without hover they are
visible at 0.75 opacity by default; focus still reveals them fully. The existing message-footer
touch default of 0.75 is preserved. Icon colors retain their surface roles: full opacity does not
replace the deliberately subdued glyph color.

Pending retains its independently decided panel-level idle dimming, transparent background and
quiet border. All its actions stay locally opaque and inherit the panel's 0.75-to-1 emphasis; do not
add a second opacity layer to individual buttons. Content roles, disclosure structure, clipboard
payloads and operation guards remain unchanged. [[conversation]] and [[composer]] own their behavior.

The user-approved project-wide quiet-button trial assigns presentation by a control's role,
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
These secondary actions stay directly available; this trial changes presentation, not event handling,
keyboard order, focus ownership or operation guards.

Content availability is a capability concern, not a fourth presentation type. Design straightforward
copy behavior for the content rather than hiding an action simply because the current implementation
only copies text. Image-only content should support image copying. Multiple images may be copied
separately if that produces a useful result; in that case write them in reverse input order so the
earliest-entered image is copied last and sits at the top/first position in clipboard history.
The image-copy implementation and effective paste behavior remain to be established.

## Responsive, motion, and accessibility

- Below the narrow-workbench breakpoint, navigation and contextual work become
  independent modal drawers instead of squeezing both side regions around
  phone-sized conversation content. Fixed narrow surfaces honor all four safe
  insets. Each drawer provides its own close button inside the focus boundary.
  Narrow drawers slide in from their respective edges as opaque surfaces. Navigation uses the
  theme's darkening overlay token; the full-width context pane has no redundant scrim. Narrow
  Settings enters with an opaque 8px rise while only its backdrop fades. Dismissal is immediate,
  and reduced motion removes entry animation.
- Motion explains a transient surface, disclosure, or live work. Shared
  durations are 90ms micro, 150ms standard, and 180ms panel; active work may
  spin, and the whole composer carries a quiet 2.8-second theme-colored
  breathing halo only while its run state is `running`. Retrying, compacting,
  and terminal states retain static semantic halos rather than breathing or
  flashing. Short card/palette entrance and disclosure transforms are
  permitted. Reduced-motion mode keeps the running halo static, removes
  nonessential animation, and collapses transitions to a negligible duration.
- Text meets WCAG AA contrast, and graphical focus/status cues meet their UI
  contrast threshold. `:focus-visible` uses the shared 2px accent outline;
  controls retain named roles, native semantic structure, visible keyboard
  focus, and focus restoration after overlay close. Touch controls occupy real
  layout space rather than overlapping pseudo-targets.

## Checks

- `tests/web/styles-contract.test.ts` verifies declared CSS variables, the
  permanent brand/surface/activity token families, traffic-light navigation
  roles, all-edge narrow safe-area use, and the absence of composer pulse or
  completion-flash keyframes.
- Theme bootstrap and overlay ownership have focused web tests; mock-host
  browser coverage checks desktop and narrow workbench behavior, including the
  320px and 390px controls, drawer dismissal, and keyboard/accessibility paths.
- A visual change is evaluated in both luminosity modes and both palettes when
  its affected role appears in each; it does not create a second component
  architecture or a local exception token.

## Non-goals

- The system does not reproduce a reference application's palette, typography,
  artwork, or component identity.
- It does not use a teal default, a mixed Amber/Jade surface ladder, a legacy
  mixed-case lockup, large decorative brand motifs, persistent breathing,
  completion celebration, or a second responsive component structure.
