---
purpose: The concrete design-token and component contract for insπre’s front end; single design authority that styles.css and the components implement.
covers:
  - index.html
  - public/favicon.svg
  - public/app-icon.svg
  - public/app-icon-maskable.svg
  - public/app-icon-192.png
  - public/app-icon-512.png
  - public/app-icon-maskable-512.png
  - public/apple-touch-icon.png
  - src/styles.css
  - src/assets/fonts/**
  - src/assets/licenses/**
  - scripts/import-ibm-plex-sans-sc.mjs
  - scripts/verify-release-package.mjs
  - src/**/*.tsx
  - tests/web/app.test.tsx
tokens:
  colors-light:
    canvas: "#f7f9f8"
    surface: "#ffffff"
    surface-inset: "#eef1f0"
    hairline: "#e2e7e5"
    hairline-strong: "#c8d1ce"
    ink: "#1c2321"
    body: "#2e3634"
    muted: "#5d6664"
    faint: "#68736f"          # weakest text that is still text: ≥4.5:1 on surface
    accent: "#00928c"          # teal-500, brand anchor (borders, icons, selection, focus)
    accent-hover: "#00a29b"
    accent-fill: "#00827c"     # teal-600, filled controls with on-accent text (≥4.5:1)
    accent-deep: "#00726d"     # teal-700, links and small accent text on light (≥4.5:1)
    accent-active: "#01514d"
    accent-tint: "rgba(0, 146, 140, 0.08)"
    on-accent: "#ffffff"
    success: "#2f7d4f"
    warning: "#946600"
    error: "#b3403c"
    on-status: "#ffffff"        # foreground on filled warning/error controls
    error-tint: "rgba(179, 64, 60, 0.08)"
    warning-tint: "rgba(148, 102, 0, 0.08)"
    info: "#33649e"            # annotation: tool activity
    think: "#7b5fc0"           # annotation: reasoning blocks
    think-tint: "rgba(123, 95, 192, 0.06)"
    git-modified: "= warning"   # identifier-list git text, ≥4.5:1 on surface
    git-untracked: "= success"
    git-conflict: "= error"
  colors-dark:
    canvas: "#111413"
    surface: "#191e1d"
    surface-raised: "#232928"
    surface-inset: "#0c0f0e"
    hairline: "#2c3331"
    hairline-strong: "#414947"
    ink: "#ecefee"
    body: "#ccd2d0"
    muted: "#939d99"
    faint: "#89938f"
    accent: "#4dd8cd"          # teal-300: the light anchor's hue, raised for dark
    accent-hover: "#71e3d9"
    accent-fill: "#3fcfc4"     # filled controls carry near-black on-accent text
    accent-deep: "#4dd8cd"     # equals accent: already ample contrast on dark
    accent-active: "#2aa89e"
    accent-tint: "rgba(77, 216, 205, 0.09)"
    on-accent: "#06211f"
    success: "#5fc78e"
    warning: "#e0b054"
    error: "#e5837b"
    on-status: "#06211f"        # foreground on filled warning/error controls
    error-tint: "rgba(229, 131, 123, 0.12)"
    warning-tint: "rgba(224, 176, 84, 0.12)"
    info: "#7ea9dd"
    think: "#b9a7ee"
    think-tint: "rgba(185, 167, 238, 0.10)"
    git-modified: "= warning"   # identifier-list git text, ≥4.5:1 on surface
    git-untracked: "= success"
    git-conflict: "= error"
  typography:
    sans: "'IBM Plex Sans SC', system-ui, sans-serif"
    serif: "'IBM Plex Serif', Georgia, serif"          # wordmark only
    mono: "'Flux Mono SC', ui-monospace, monospace"
    size-xs: 11.5px      # chip, meta rows
    size-sm: 12.5px      # secondary UI, code, card summaries
    size-base: 14px      # controls, nav, composer
    size-md: 15px        # transcript reading body
    size-lg: 16.5px      # content h3
    size-xl: 19px        # content h2
    size-2xl: 23px       # content h1
    size-wordmark: 26px
    leading-ui: 1.45
    leading-reading: 1.65
    leading-mono: 1.6
    weight-regular: 400
    weight-medium: 500
    weight-semibold: 600   # maximum weight in the system
  spacing:
    unit: 4px
    scale: [4, 8, 12, 16, 20, 24, 32, 48, 64]
    reading-column: 760px
    nav-width: 272px
    context-width: "clamp(340px, 38vw, 760px)"   # wide enough to genuinely preview documents
  rounded:
    xs: 4px       # inline code
    sm: 6px       # buttons, inputs, selects
    md: 8px       # cards, code blocks, chips with square corners
    lg: 12px      # user bubble, dialogs, pickers, palette
    pill: 999px   # chips, badges
  elevation:
    level-0: "none; 1px hairline border"
    level-1: "0 1px 2px rgba(23,31,29,0.06)"
    level-2: "0 4px 16px rgba(23,31,29,0.10)"
    overlay: "0 24px 64px rgba(23,31,29,0.18); 40%-alpha scrim + 7px backdrop blur"
    dark-note: "dark theme replaces level-1/2 with surface-raised + hairline-strong; the overlay shadow remains (0 24px 64px rgba(0,0,0,0.40))"
  motion:
    micro: "120ms ease-out"     # hover, focus, chip state
    standard: "180ms ease-out"  # card collapse, palette open
    panel: "240ms ease-out"     # nav/context slide
    breathe: "1.8–2.4s ease-in-out loop"  # live chips and dots only
---

# Design system

## Overview

insπre reads as a restrained scientific instrument: near-neutral paper
surfaces with a faint cool-green cast, hairline boundaries, soft radii, one
teal accent family, and one IBM Plex type system — Sans SC for interface and
Chinese/Latin text, Serif for the wordmark, and Mono for code. Content —
Markdown, KaTeX mathematics, highlighted code — carries the character; chrome
stays quiet.

The two themes share one component architecture, one information hierarchy,
and one accent hue: **teal `{colors-light.accent}` in light**, the same hue
raised to a **luminous teal `{colors-dark.accent}` in dark**. High-chroma lime
against muted green-grays reads harsh and murky; the brighter teal keeps the
brand hue and calms the theme. Beyond the accent, a small **annotation palette**
color-codes conversation block types in both themes. Light is the primary
tuning target; dark follows it and is verified, not separately designed.

Key characteristics:

- Paper-not-cream neutrals: the light canvas is a cool-green-tinted white,
  deliberately away from both Anthropic cream and dev-tool blue-gray.
- One interactive accent family per theme with named roles (`accent`,
  `accent-fill`, `accent-deep`, `accent-tint`); annotation hues are
  semantic block coding, never decoration.
- IBM Plex Sans SC everywhere, so Chinese and Latin share one family with no
  fallback seam; Serif exists only in the `insπre` wordmark (set italic,
  with the π in KaTeX's math italic face); Plex Mono owns code and machine
  data with Sans SC as its Chinese fallback.
- KaTeX renders with its own bundled fonts; the system never restyles formula
  glyphs, only the spacing around them.
- Hairline borders do the separating; shadows are reserved for genuinely
  floating surfaces (palette, dialogs, pickers).
- Semibold (600) is the loudest weight in the product; emphasis comes from
  hierarchy and accent, never from heavy or oversized type.

## Colors

### Roles

Every accent use maps to one of four named roles; components must not invent
intermediate values:

- **`accent`** — identity and interaction: focus rings, selection borders and
  the π in the wordmark, active-session markers, checked controls, links in
  dark theme, and the context gauge.
- **`accent-fill`** — the only filled-control background (primary button,
  send button, active chip). Text on it is `on-accent`. Light uses a step
  deeper than `accent` so white text passes 4.5:1; dark uses a bright fill
  with near-black text.
- **`accent-deep`** — small accent text on light surfaces (links, inline
  emphasis); equals `accent` in dark where contrast is already ample.
- **`accent-tint`** — low-alpha wash for selected rows, drop targets, and the
  user bubble background.

### Annotation palette

Conversation block types are color-coded by a 3px left edge plus a matching
icon — the same grammar toast notices already use. The hues are semantic,
theme-tuned, and graphics-only (edges and 14px icons, ≥3:1; never prose or
chrome text, never fills). One scoped exception: identifier lists (file
trees) may carry git state color on the name itself, through the text-tuned
`git-*` role tokens, because there the name is data, not reading text:

- **`think`** (violet) — thinking cards; the expanded body also takes a
  ~4% violet-tinted inset.
- **`info`** (blue) — tool cards and live tool-activity chips. The 14px tool
  icon carries the tool type (read FileText, edit FilePen, write FilePlus2,
  bash SquareTerminal, grep Search, find FileSearch, ls List, unknown Wrench)
  in both the card header and the compact tile, so a settled batch scans by
  glyph before a single label is read.
- **`error`** — failed tool cards and error notices.
- **`hairline-strong`** (neutral) — unknown/extension content: uncommitted.
- Runtime outcomes use a traffic-light grammar independent of the teal brand
  accent: working is `warning` and breathes, completed is `success`, and failed
  is `error`. Needs-recovery attention also uses `warning`, but rests under a
  static ring so it does not impersonate live work. The context gauge retains
  the warning/error caution tones.

Git state decorates identifier lists (workspace explorer, referenced-files
list) the way editor trees do: a changed file's name carries
`git-modified` / `git-untracked` / `git-conflict` — text-tuned role aliases of the
warning/success/error families, each ≥4.5:1 on `surface` — while the letter
mark shares that hue and stays as the second channel naming the exact state.
Directories roll up
the most severe descendant state (conflict > modified > untracked) through
name color plus a same-hue generic dot, so a dirty subtree reads from the root
without expansion and without relying on color alone; dots and letters occupy
the same centered 15px trailing slot, and a mixed state never invents a letter. Unresolvable (missing) references keep
their strikethrough style instead of a git color, and the Changes pane stays
uncolored — every row there is dirty by definition, so color would not
discriminate within the list.

### Discipline

- Neutral surfaces carry ≥95% of any screen; accent appears only where it
  communicates interaction or state, annotation hues only on block edges
  and icons.
- The dark teal is a small-area color: focus rings, selection edges, links,
  the gauge, and the compact `accent-fill` controls. It is never a panel
  background, banner fill, runtime-outcome color, or large illustration color.
- Semantic colors (success/warning/error) appear only with a semantic
  meaning, tuned per theme, and never as decoration.
- All text/background pairs meet WCAG AA (4.5:1 body, 3:1 large or UI
  graphics) in both themes; `accent` on light and the annotation hues are
  3:1 graphics-only colors — small accent text must use `accent-deep`, and
  `faint` is tuned to stay ≥4.5:1 on `surface` in both themes.

## Typography

### Families

- **Sans — IBM Plex Sans SC** (Regular 400, Medium 500, SemiBold 600):
  interface, transcript body, Chinese and Latin alike. The application vendors
  the complete official Unicode-split WOFF2 delivery from
  `@ibm/plex-sans-sc@1.1.0`: 216 untouched faces per weight. The browser loads
  only ranges intersecting rendered text and caches them; the three complete
  3.8–4.0 MiB faces are deliberately absent. `system-ui`/`sans-serif` closes
  the stack for characters outside the IBM repertoire.
- **Serif — IBM Plex Serif**: the `insπre` wordmark only. No reading mode,
  no serif body text; the wordmark is Latin + π so no CJK serif is needed.
- **Mono — Flux Mono SC** (Regular 400, Medium 500): code blocks, inline
  code, session IDs, paths, tool arguments and results. Its independent OFL
  v0.1.0 release derives from IBM Plex Mono and IBM Plex Sans SC under a new
  family name, supplies Chinese directly, and enforces a strict 600/1200-unit
  single/double-cell grid without fallback-driven metric drift.

The Sans SC UI split files remain byte-for-byte IBM originals so they may retain
OFL Reserved Font Name `Plex`. `scripts/import-ibm-plex-sans-sc.mjs` accepts
only the exact integrity-pinned 1.1.0 npm archive without executing package
scripts. Flux is not rebuilt here: Inspire vendors the tagged v0.1.0 Web
artifacts from `XWIlluDelu/flux-mono`, pins its manifest and all 112 shard hashes,
and carries its own OFL/NOTICE. The release verifier checks the complete IBM UI
and Flux code asset sets after production installation. Future upgrades must
renew those witnesses deliberately; ordinary builds contact neither npm nor
GitHub.

### Hierarchy

- UI text sits at `{typography.size-base}`/`{typography.leading-ui}`;
  secondary UI and code at `{typography.size-sm}`; meta rows and chips at
  `{typography.size-xs}`.
- Transcript reading body uses `{typography.size-md}` with
  `{typography.leading-reading}`; rendered Markdown headings map h1→
  `{typography.size-2xl}`, h2→`{typography.size-xl}`, h3→
  `{typography.size-lg}`, all `{typography.weight-semibold}`, and deeper
  levels clamp to h3 size.
- Weight vocabulary: 400 body, 500 controls and labels, 600 headings and
  the strongest emphasis. Never 700+.
- CJK text never receives `letter-spacing`; uppercase tracking applies only
  to short Latin labels (chip tags, section labels).

## Layout

### Spacing

All gaps come from `{spacing.scale}`. Component interiors use 8/12/16;
between-block rhythm in the transcript is 16; panel padding is 16–24;
nothing exceeds 32 inside the workbench (64 is reserved for welcome-page
breathing room).

### Workbench grid

- Left navigation: fixed `{spacing.nav-width}`, collapsible to a 48px rail.
- Center: fluid; transcript and composer content constrained to
  `{spacing.reading-column}` centered.
- Right context pane: `{spacing.context-width}`, overlay-or-column, opens on
  demand.
- Topbar: 48px tall, canvas background, no separating line — scrolled
  transcript content dissolves under it through a short top fade mask.

### Whitespace philosophy

Medium density: the workbench shows structure without console clutter.
Structural seams between the workbench regions are carried by background
steps alone (`surface` panes against the `canvas` center — no vertical
hairlines, no line under the header row); hairlines belong to in-content
structure — cards, code blocks, tables, the composer — where they mark
instruments, not architecture. Separation prefers whitespace over
boxes-in-boxes; a surface nests at most one level deep inside another
surface (card → code block is the maximum).

## Elevation & depth

- **Level 0** (`{elevation.level-0}`): everything resting in the layout —
  cards, composer, nav rows, code blocks. Hairline border, no shadow.
- **Level 1** (`{elevation.level-1}`): sticky/transient in-flow elements —
  jump-to-latest, banners.
- **Level 2** (`{elevation.level-2}`): anchored floating surfaces — pickers,
  notices, dropdowns.
- **Overlay** (`{elevation.overlay}`): modal surfaces — command palette,
  settings, extension dialogs. The scrim carries a 7px backdrop blur so the
  workbench recedes into depth-of-field; this is the one shadow dark keeps.
- Dark theme conveys levels 0–2 with `surface` → `surface-raised` steps and
  `hairline-strong` edges instead of shadows.

## Shapes

`{rounded.sm}` for interactive controls (buttons, inputs, selects),
`{rounded.md}` for resting containers (cards, code blocks), `{rounded.lg}`
for conversational and floating surfaces (user bubble, dialogs, palette,
pickers), `{rounded.pill}` for chips and badges, `{rounded.xs}` for inline
code. No other radii.

## Components

### Buttons

- **`button-primary`** — background `accent-fill`, text `on-accent`,
  `{typography.size-base}`/500, padding 8px×14px, `{rounded.sm}`. Hover
  lightens to `accent-hover` (dark: brightens), active `accent-active`,
  disabled drops to `surface-inset` + `faint`.
- **`button-secondary`** — `surface` background, `body` text, hairline
  border; hover raises border to `hairline-strong` and tints background.
- **`icon-button`** — 28px square, transparent, `muted` icon at 14–16px;
  hover shows `surface-inset`; active/toggled state uses `accent` icon plus
  `accent-tint` background.
- **`send/abort`** — the send button is `button-primary` sized to the
  composer; abort keeps the same geometry with `error` semantics, while
  conflict recovery uses the same geometry with `warning` semantics. Filled
  status controls use the theme's `on-status` foreground.

### Chips & badges

Tinted capsules (`{rounded.pill}`, `{typography.size-xs}`/500, 0.02em
tracking, 2px×10px padding): each semantic variant fills with its hue at
10% over a 22% border — accent, warning, info, error — while muted sits on
`surface-inset` with a plain hairline. Chips are single-line, icon 12px.
Motion is part of the grammar: every chip enters with a 96%→100%
fade-scale, and a state still in progress (running, retrying, compacting,
live tool, reconnect) breathes a soft halo in its own hue
(`{motion.breathe}`); terminal states rest. Running and retrying use the
warning capsule, keeping active work visually separate from green completion
and red failure. The mock badge shares the warning capsule surface.

### Workbench chrome

- **Header row** — all three regions (nav, topbar, context pane) share a
  48px header height with no underline; the seam is the background step and,
  in the center, the scroll-under fade. The nav header holds the italic
  serif wordmark (π in KaTeX math italic) and the mock badge; the rail shows
  the math-italic π alone.
- **Installed-app identity** — the mark is a precision optical reticle: four
  cardinal sight lines converge on a small hollow circle, while one 60° arc in
  the upper-right and its 180° counterpart in the lower-left carry the circular
  visual reference to Pi without reusing the π glyph. The geometry is teal and
  white only. Sight lines, arcs, and the closed center ring have separately
  compensated weights; exposed master-mark terminals receive only a sub-unit
  manufacturing radius, preserving the instrument character without brittle
  knife edges. Ordinary launcher assets place the master mark on the deep-teal
  rounded tile; maskable and Apple assets use a full-bleed deep-teal field so
  the operating system owns the final silhouette. The transparent browser
  favicon is a separately drawn 16-unit optical size with one-pixel key strokes
  and a white dark-scheme projection, not a mechanical reduction of the master.
- **Topbar identity** — the session heading (600) is the rename affordance. An
  explicit Pi session name wins; otherwise the same normalized first-prompt
  projection used by navigation is shown, while a conversation with no prompt
  reads `New session`. This fallback is presentation only: rename still opens
  with an empty value, and prompt text never enters the browser/OS title or a
  desktop notification. The heading flexes and ellipsizes at its actual width;
  its full bounded value remains in the hover title. Beside it the project
  location renders in mono `{typography.size-xs}` `faint` — folder name or full
  path per the `projectDisplay` preference — and clicking it copies the absolute
  path. A quiet Git control follows the project and deliberately reuses that
  exact mono metadata grammar: branch (or detached/unborn identity) is always
  shown at ordinary widths, a same-style `· N changes` suffix appears only when
  non-clean, and activation opens detailed Git Changes in the context pane.
  Ordinary changes remain neutral; a conflicted count is `error`, while an
  otherwise stale status is `warning`, without changing the shared typography
  or spacing. It is contextual identity rather than a runtime-status capsule.
  On a phone the branch text yields to the session title and fixed actions, leaving
  the Git glyph and any change count with the full state in its accessible name
  and tooltip. The model is never shown here. Identity degrades in named
  discard tiers keyed to the bar's own width (container queries), never by
  proportional truncation of everything at once: below 820px the project
  location yields first (navigation and the workspace explorer already carry
  it), below 600px the Git branch text yields to the glyph plus any change
  count (the full state stays in the accessible name and tooltip), and only
  then may the session title ellipsize. The phone tier applies the same
  grammar by viewport.
- **Topbar status and actions** — runtime and extension status capsules remain
  in the leading cluster, immediately after session identity, while the action
  targets stay fixed at the right. Status is vertically centered; long extension
  text ellipsizes with its full value in the tooltip. Every capsule keeps literal
  descendant status text and a title when responsive CSS visually hides its label;
  generic wrapper elements never rely on an author-supplied accessible name. The
  focused browser gate checks the narrow topbar and composer with axe rather than
  treating a hover-only tooltip as semantic evidence. The session title and project location yield first,
  and the bounded status cluster yields next, so
  neither can cross the command palette, settings (opens the settings overlay),
  or context-pane targets. The nav toggle remains at the left. There
  is no compact button: users type `/compact [instructions]`, which the
  host routes to Pi's RPC compact command. Below 900px, the open navigation
  drawer begins beneath the 48px center topbar, so this one toggle remains
  above it and hit-testable by pointer, touch, and keyboard; the drawer adds
  one trailing close target inside its own header and a click-to-dismiss scrim.
- **Context modes** — the right pane keeps Files, Changes, and History in one
  compact mode switch rather than adding another workbench column. Changes is
  Git working-tree inspection; History is Pi conversation history and branch
  navigation, never Git branch selection. History uses a bounded, vertically scrollable entry tree: role chips and one-line
  snippets form the main row, active ancestry uses the accent rail, and the
  effective leaf is the only `aria-current` row. Switch uses the row itself;
  edit-from-here and fork are quiet trailing icon actions. Reversible switch and
  fork do not block on confirmation; edit confirms only when it replaces a
  non-empty composer draft. Host truncation and stale/error state remain visible
  above or below the tree.
- **Start surface** — the welcome canvas carries the brand at its one full
  scale: the hero composes the reticle mark at 32px beside the large
  wordmark, the same pair the nav header carries at 22px, over the tagline;
  and the one piece of brand ornament — a huge KaTeX math-italic π watermark
  at 4% ink (5% in dark)
  receding into the lower-right corner, clipped by its own layer so it
  never scrolls or intercepts input. Its recent-session list appears only
  when navigation is collapsed; the expanded navigation already owns the same
  session choices and the welcome surface does not duplicate them.

### Navigation

- Folder-first hierarchy: group headers are a quiet semibold tier above their rows — `{typography.size-sm}`/600 `muted` with `0.04em` tracking on a 28px line. The entire header row toggles the folder, not just its label. The chevron is 13px and the folder glyph is 14px; folder curation uses the same two 22px trailing action targets as session rows. Session rows remain single-line at `{typography.size-sm}`/400 `ink`. Each row carries exactly one number: a compact activity age in `faint` `{typography.size-xs}`, right-aligned in a fixed 46px column, preceded by the project as a `surface-inset` pill only where a section crosses folders. The header's session count occupies that same 46px column at `{typography.size-xs}`, so counts and ages read down one rule; the exact timestamp and message count stay in tooltips.
- Groups collapse freely — including the visible session's group; a collapsed
  folder that hides the visible session takes the `accent-tint` highlight and
  2px `accent` left edge itself. Active search overrides collapse. Each session
  remains in its one curated location: its row dot alone reports busy work,
  unseen completion/failure, or recovery, so runtime transitions never duplicate
  a row into a separate status group or disrupt spatial memory. Hidden remains
  an explicit curation choice, and its rows retain the same state dots when the
  drawer is expanded. Opening the New session surface host-deselects the prior
  session: its worker may remain only as an unselected idle cache entry, while
  navigation selection, topbar status, resources, completion acknowledgement,
  and Escape targeting all clear. No session row or folder then claims
  current-page styling.
- Row hover shows `surface-inset`; the visible row pairs the 2px `accent`
  inset edge with an `accent-tint` wash that fades toward the right, so the
  highlight points back at the edge. Runtime dots use `warning` for working,
  `success` for completed, and `error` for failed. Working breathes
  (`{motion.breathe}`); needs-recovery also uses `warning` but rests under a
  soft 3px ring, as do the green and red terminal-attention dots.
- Curation actions are two 22px `faint` icon buttons occupying exactly the 46px age/count column, which fades as they appear on hover or focus, so no text moves. Ordinary session and folder rows expose Pin + Hide; Hidden sessions expose Restore + Delete, while Hidden folders expose Restore without inventing folder deletion. Delete uses `error` only on hover/focus. Folder Hidden is independent metadata keyed by exact cwd: restoring a folder preserves any sessions hidden individually, and Pin/Hidden are mutually exclusive at the folder level. The four navigation sections — pinned sessions, pinned folders, ordinary folders, Hidden (sessions and whole folders) — separate by a spacing step, never by a rule.
- Session pagination is a compact bordered text control below the chronological groups. It appears only while loading, on failure, or while older sessions remain; a fully loaded list emits no redundant `Showing N of N` or completion message. Loading disables the same control with a spinner, failure turns it into an explicit retry named for the failed operation (including preservation refresh), and the touch layout raises the target to 40px.
- The **workspace explorer** sits at the nav's bottom edge while a session is
  visible: collapsed it is a single header bar (folder icon + project name +
  chevron); expanded it takes up to half the column with a lazily loaded tree
  derived from the host's project index (directories first), and clicking a
  file opens the session-bound preview pane. Names carry the git decoration
  grammar — changed files color and keep their letter mark, while directories
  roll up descendant state through name color plus a generic dot — so a dirty
  subtree reads from the root. The New session surface hides the
  prior runtime's explorer rather than presenting its workspace as current.
- The nav column begins with one brand/new-session target: the transparent
  22px reticle favicon + wordmark align to the same left content axis as Search,
  while `New session` occupies the trailing side. The untouched default column
  width scales continuously from 272px to its 220px floor; neither the brand
  action's typography nor the adjacent topbar toggle changes its anchor at the
  1280/1100px content breakpoints. The collapsed rail carries the same reticle
  alone at 26px. The rail
  already supplies product identity, so the topbar continues to show the
  visible session title and shows no duplicate wordmark on the welcome surface.
  It follows the favicon's theme colors (teal in light, white in dark) and opens
  the welcome/new-session surface without creating a session. It remains an
  action button even while that surface is open: no selected/current-page state
  or persistent fill is shown. On narrow columns
  the action chip disappears before it can clip. Search, sessions, and the
  explorer follow; settings and refresh live in the topbar and palette
  respectively.

### Transcript

- **Conversation search** — a compact Level-1 pill floats at the transcript viewport's upper-right, aligned to the reading column. The pill is an **opaque** `surface` — it floats over scrolling content, and a translucent one lets text read through and collide with the controls; the transcript's `scroll-padding-top` keeps search jumps and anchored rows below the pill zone. Its empty, unfocused idle state keeps full text/icon opacity and no shadow; hover, focus-within (including the scope menu), or a nonempty query adds only the Level-1 shadow over `{motion.micro}`. A quiet scope dropdown selects All, User, or Model while the literal query, match count, and previous/next controls retain the original compact anatomy. The transcript reserves its opening top offset; on narrow layouts the pill spans the available width without horizontal overflow.
- **Earlier history** — approaching the transcript top loads the next page without a normal-state control. A quiet centered status appears only while loading; failure replaces it with a compact retry action and pauses automatic loading until the user retries. Prepending history preserves the visible reading position.
- **Earlier-branch context** — when the effective leaf differs from the durable leaf, a restrained Level-1 banner sits above the transcript reading flow: `Viewing an earlier branch`, followed by explicit `Back to latest` and `Fork from here` actions. It remains visible when the right History pane closes or switches modes, so the user never loses the context that a visible transcript is not the durable latest branch.
- **User bubble** — right-aligned, unlabeled, max-width 85% of the reading
  column, `accent-tint` background, `accent`-alpha hairline, `{rounded.lg}`,
  `{typography.size-md}` text; the full timestamp is the tooltip. Extra
  spacing before each user turn groups a prompt with its response. Per-turn
  actions (copy, fork) stay out of the reading flow: hidden at rest, revealed
  on turn hover or focus-within; touch devices without hover keep them
  faintly visible so the affordance stays discoverable.
- **Assistant flow** — no container. The `Assistant rounds` preference is a pure presentation choice: `Details` preserves the existing attribution head line ("Pi" at `{typography.size-sm}`/600 with model, time, and any unusual end reason in `{typography.size-xs}` `faint`/`warning`), while `Divider` replaces that whole line with one 24px neutral hairline centered in the ordinary turn gap, adding no exception text, inferred state, semantic color, or replacement line height. There is no footer meta line.
- **Thinking card / tool card / displayed-custom card / generic card** — one collapsible card anatomy: ~34px header row (icon 14px, label, one-line summary, status icon, chevron), `{rounded.md}`, `surface` background, hairline border, and a 3px annotation-colored left edge (`think` violet / `info` blue / `error` when failed / `hairline-strong` unknown) with the icon in the same hue. Thinking summaries are inline-rendered sans prose (emphasis, inline code, and math survive within the one-line ellipsis); tool summaries are mono; labels sit at `{typography.size-sm}` 600 (tool names mono 500). A displayed Pi custom message uses the tool-aligned blue edge, 14px Package glyph, monospaced attributable title, and the same inspection/density geometry. Its Compact tile includes the exact `customType` but no invented success/failure glyph because custom messages have no result contract. Generic extension cards instead use an attributable normal-sans title and suppress raw `custom`/`Extension content` labels; anonymous custom parts and Pi custom messages marked `display: false` are omitted rather than rendered as repetitive placeholders. Meaningfully typed or attributed content keeps its implementation type and payload in the expanded body. Expanded bodies are inset with a hairline top; thinking bodies take a faint violet tint. Dynamic is the recommended and default density: Thinking remains Expanded for at least 1.8 seconds, each completed tool for at least 1.6 seconds, and a closed batch remains visibly Collapsed for at least 800 ms after its 180 ms body transition before Compact may begin. Result outcome affects status color/glyph only, never this lifecycle. Tool cards also expose fixed `Compact`: each uninterrupted adjacent run becomes a wrapping row of quiet 30px tiles — a 3px semantic left edge, tool icon, status glyph, and restrained padding/spacing. Clicking one animates its ordinary detail panel downward immediately beneath that row; selecting another replaces the panel in place. The outer hairline remains neutral; failure turns the short semantic edge, tool icon, and status glyph red in both resting and selected states. Compact grouping never crosses text, thinking, or generic content. It may cross the storage-level assistant-message boundary only when a displayed custom run follows the assistant’s final tool-call run through that run’s paired, non-rendered tool results; together they are one visible activity run. Dynamic closes each full card in place, briefly fades the settled batch, then introduces its Compact tiles with only a 4px upward fade; it never flies full-width cards across the transcript or interpolates their geometry into tiles. Initial history and reduced-motion rendering switch directly without replay.
- **Code block** — `surface` (dark: `surface-inset`) background, hairline
  border, `{rounded.md}`, header bar with language label
  (`{typography.size-xs}` `faint`) and copy action; code at
  `{typography.size-sm}`/`{typography.leading-mono}`. Syntax colors derive
  from the theme palette: accent for keywords, warning-adjacent for
  strings, `muted` for comments — max five hue roles.
- **Tables** — hairline row separators only, semibold header row, no zebra.
- **Task lists** — GFM checkboxes are pulled into the control language:
  `accent-color: accent-fill` at 13px, aligned to the reading baseline; never
  the browser-default grey.
- **KaTeX** — display math gets 12px vertical margin, inner padding so tall
  glyphs clear the scroll container's clip edge, and horizontal scroll
  containment; never restyled glyphs.

### Composer

A level-0 surface at the reading column width: ordinary attachment/reference
chips and 64px image-thumbnail tiles on top, auto-growing textarea
(`{typography.size-md}`, max 40vh), and a meta row. Image tiles omit file
metadata, keep removal as a corner action, and open a centered image viewer.
The viewer uses one full-viewport translucent blur plane with the crisp image
above it and no image-edge shadow; image activation toggles fit/2× zoom, while
thresholded drag pans only after zoom. Backdrop, close control, and Escape own
dismissal. Sent user turns reuse the same thumbnail/viewer grammar. Model and
thinking level are quiet content-sized dropdowns: a
`{typography.size-sm}` value plus 11px chevron (flips while open) that
hugs its value when closed. The menu is the themed replacement for the
OS-drawn native option popup — a Level-2 anchored listbox (raised surface,
hairline border, `{rounded.md}`, float-in) that opens upward from the
bottom-docked composer; the selected option reads `accent-deep` with a
check glyph, the pointed row rests on the inset background. Quiet finite
controls follow the select-only combobox pattern: focus stays on the trigger,
arrows/Home/End move, Enter picks, Escape closes without reaching the
global abort. The model control expands this anatomy with a focused local
search field, non-selectable canonical-provider headings, and compact Active,
Recent, and No thinking labels; its active descendant indexes options rather
than headings. The closed trigger carries the model name alone — the provider
lives in its tooltip and in the menu's provider headings, not in a second
trigger line. Thinking levels read lowercase (`medium`, `xhigh`) and the
control states when the active model cannot use them. The caret completion
surface uses the same Level-2 grammar above the writing area, with source
headings in its unfiltered inventory, a mono path/description column, and an
accent edge on the active option. A typed slash query ranks command names
across sources without letting headings or descriptions displace the strongest
match. At the right, the **context gauge** — a
14px ring plus percent in `{typography.size-xs}` — reports context-window
occupancy from Pi's session stats: calm `muted`/`accent` below 60%,
`warning` from 60%, `error` from 85%, with exact token counts and a
`/compact` reminder in the tooltip; it hides when Pi has no fresh usage
data (right after compaction). Focus shows a 2px `accent` ring on the whole
composer. Drop targeting tints the composer with `accent-tint` and a dashed
`accent` border. Browser spelling/grammar proofing is disabled on the shared
textarea so technical mixed-language input receives no browser-owned correction
underlines. Below 600px the meta row wraps: model and thinking controls keep
legible labels and at least 32px targets, while context/send owns a full trailing
row rather than shrinking controls into overlap. The welcome composer follows the
same wrap; lacking the gauge, its send owns the trailing edge.

### Command palette, settings & dialogs

Centered modal surfaces at the Overlay level: the scrim dims at 40% alpha
and blurs the workbench behind it (7px + 15% saturation lift), and the
surface pops in — 97%→100% scale with a hint of spring
(`cubic-bezier(0.2, 0.9, 0.25, 1)`) over `{motion.standard}`. Palette 560px
wide, `{rounded.lg}`, input row + result list grouped under one
`{typography.size-xs}` uppercase tracked `faint` label per group — the same
single-header grammar as the model selector and the composer completion;
active row `accent-tint`
with `accent` left edge. **Settings is an overlay dialog** (600px, scrolling
within 80dvh on ordinary viewports), not a page: sectioned cards for appearance (theme, project
location), card visibility, completion attention, startup, install (the PWA
install action when the browser offers it, otherwise the installed state or
the path to it), and about; Escape and the scrim close
it, and Escape never leaks to the global abort shortcut. Below 520px the overlay
uses the full available viewport height and preference rows stack their labels
above controls, so no horizontal overflow or clipped last section remains.
Preference selects render as the composer's dropdown in a bordered field variant — hairline
border on the canvas background, opening downward, focused/open state
following the text-field grammar (accent border + tint halo). Extension
dialogs share the same surface with title at `{typography.size-lg}`
semibold and right-aligned action row. Destructive confirmation uses the same
focus-trapped surface, names the exact target, explains Trash-versus-permanent
fallback and unaffected data, warns about external Pi processes, and reserves
solid `error` fill for the final action only.

### Scroll rails

Pane scrollers hide the native bar; a 6px `--thumb` pill straddles the
pane's boundary — the nav on its right edge, the context pane on its left —
and the transcript uses a mid-height rail floating in the reading margin:
its offset grows with the available whitespace and its length runs ≈62% of
the pane height, long enough for precise dragging without a full gutter.
Thumbs rest faintly visible (40% strength) so the grab point stays
discoverable, rise to full strength on scroll or hover, and settle back
after ~0.9s idle; hover and drag deepen them through ink mixes. They are pointer affordances only — wheel
and keyboard scrolling stay native, and the rails are hidden from the
accessibility tree.

### Empty states

Primary empty surfaces (session list, command palette results, files pane)
share one stack: a 26px 1.5-stroke `faint` icon, a `{typography.size-sm}`
500 `muted` title, and one `{typography.size-xs}` `faint` hint line,
centered. Inline notes inside dense trees (explorer levels, file picker)
stay single-line text.

### Notices & banners

Toast notices sit bottom-right at Level 2 with `{rounded.md}`, a 3px semantic
left edge, and auto-dismiss. Reversible preflight or control refusals — missing
project directory, attachment/reference limits, model/thinking/rename changes,
preference persistence, and desktop-notification permission — use the warning
variant rather than the session-wide error banner. Errors with their own retry
surface remain there: open/create in navigation and the start surface, deletion
in its confirmation dialog, and branch failures in the History pane.

Global banners sit under the topbar at Level 1 with `error-tint`/warning-tint
backgrounds and a full-width hairline. Automatic reconnect and a snapshot
refresh failure without a red projection conflict are yellow; selected-session
prompt, abort, and extension-response failures without a narrower recovery
surface use red. Blocking integrity and acceptance-unknown states stay red and
actionable. A verified external source move is instead a persistent yellow
attention banner with recovery, never an auto-dismissing notice.

An unexpected React render failure replaces the workbench with one centered,
privacy-safe recovery card and a Reload page action. It never exposes the error
message, session content, or implementation stack in the page, and it must not
leave an unexplained blank viewport.

### Focus & keyboard

`:focus-visible` shows a 2px `accent` outline with 2px offset on every
interactive element in both themes; no focus styling on plain mouse click.
Text fields use one shared grammar instead of the outline: the border
settles on `accent` and a 3px `accent-tint` halo marks the focused surface
(`{motion.micro}` transition). Wrappers light up for the field they carry —
never two surfaces at once: the welcome composer stays quiet while its
project-directory field holds focus.

## Motion

`{motion.micro}` for hover/focus/chip changes, `{motion.standard}` for card
collapse, chip entry (fade + 96% scale), and modal pop-in (97% scale with a
spring hint), `{motion.panel}` for nav/context slide. Looping animation is
reserved for work in progress: spinners, and the `{motion.breathe}` halo on
live chips and the running dot. Terminal states never loop. Streaming text
must never animate per-token; it appears by layout only — the accent caret
marks arrival. `prefers-reduced-motion` reduces everything to opacity.

## Do's and don'ts

### Do

- Route every color, size, radius, and duration through the token layer in
  `src/styles.css`; components reference custom properties only.
- Keep accent fills small in both themes: beyond a chip, the gauge ring, or
  a 3px edge, use `accent-tint` instead.
- Use the annotation hues only through the 3px left-edge grammar, icon
  tints, and their paired tint washes; running text stays neutral.
- Let long technical answers dominate: chrome may not compete with content
  for contrast.
- Verify both themes by screenshot after any component change; light is
  tuned first, dark checked immediately after.

### Don't

- No serif outside the wordmark and the welcome watermark; no reading-mode
  font switching.
- No weight 700+, no letter-spacing on CJK running text (the 0.02em chip
  micro-labels are the sanctioned exception), no font-size improvisation
  outside the scale.
- No second decorative hue — the annotation palette is semantic, never
  ornament. Gradients and glows exist only as sanctioned grammar: the
  active-row tint fade, the focus halo, and the live breathing pulse — no
  large accent fills.
- No shadows on resting surfaces; no borderless floating cards.
- No per-component palette values, and no theme-specific component
  structure.
