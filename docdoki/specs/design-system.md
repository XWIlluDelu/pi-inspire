---
purpose: The concrete design-token and component contract for insπre’s front end; single design authority that styles.css and the components implement.
covers:
  - index.html
  - src/styles.css
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
    faint: "#6d7873"          # weakest text that is still text: ≥4.5:1 on surface
    accent: "#00928c"          # teal-500, brand anchor (borders, icons, selection, focus)
    accent-hover: "#00a29b"
    accent-fill: "#00827c"     # teal-600, filled controls with on-accent text (≥4.5:1)
    accent-deep: "#00726d"     # teal-700, links and small accent text on light (≥4.5:1)
    accent-active: "#01514d"
    accent-tint: "rgba(0, 146, 140, 0.08)"
    on-accent: "#ffffff"
    success: "#2f7d4f"
    warning: "#9a6b00"
    error: "#b3403c"
    error-tint: "rgba(179, 64, 60, 0.08)"
    warning-tint: "rgba(154, 107, 0, 0.08)"
    info: "#33649e"            # annotation: tool activity
    think: "#7b5fc0"           # annotation: reasoning blocks
    think-tint: "rgba(123, 95, 192, 0.06)"
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
    faint: "#7f8983"
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
    error-tint: "rgba(229, 131, 123, 0.12)"
    warning-tint: "rgba(224, 176, 84, 0.12)"
    info: "#7ea9dd"
    think: "#b9a7ee"
    think-tint: "rgba(185, 167, 238, 0.10)"
  typography:
    sans: "'Noto Sans SC', 'IBM Plex Sans', sans-serif"
    serif: "'IBM Plex Serif', serif"          # wordmark only
    mono: "'IBM Plex Mono', 'Noto Sans SC', monospace"
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
    dark-note: "dark theme replaces shadows with surface-raised + hairline-strong"
  motion:
    micro: "120ms ease-out"     # hover, focus, chip state
    standard: "180ms ease-out"  # card collapse, palette open
    panel: "240ms ease-out"     # nav/context slide
---

# Design system

## Overview

insπre reads as a restrained scientific instrument: near-neutral paper
surfaces with a faint cool-green cast, hairline boundaries, soft radii, one
teal accent family, and one type voice — Noto Sans SC for interface and
Chinese text, IBM Plex for the wordmark and code. Content — Markdown, KaTeX
mathematics, highlighted code — carries the character; chrome stays quiet.

The two themes share one component architecture, one information hierarchy,
and one accent hue: **teal `{colors-light.accent}` in light**, the same hue
raised to a **luminous teal `{colors-dark.accent}` in dark**. (The earlier
dark chartreuse was reviewed on 2026-07-23 and replaced: high-chroma lime
against muted green-grays read harsh and murky; the brighter teal keeps the
brand hue and calms the theme.) Beyond the accent, a small **annotation
palette** color-codes conversation block types in both themes. Light is the
primary tuning target; dark follows it and is verified, not separately
designed.

Key characteristics:

- Paper-not-cream neutrals: the light canvas is a cool-green-tinted white,
  deliberately away from both Anthropic cream and dev-tool blue-gray.
- One interactive accent family per theme with named roles (`accent`,
  `accent-fill`, `accent-deep`, `accent-tint`); annotation hues are
  semantic block coding, never decoration.
- Noto Sans SC everywhere, so Chinese and Latin share one family with no
  fallback seam; serif exists only in the `insπre` wordmark (set italic,
  with the π in KaTeX's math italic face); Plex Mono owns code and machine
  data with the sans CJK face as its CJK fallback.
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

- **`accent`** — identity and state: focus rings, selection borders and the π
  in the wordmark, active-session markers, running indicators, checked
  controls, links in dark theme, the context gauge.
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
theme-tuned, and graphics-only (edges and 14px icons, ≥3:1; never text,
never fills):

- **`think`** (violet) — thinking cards; the expanded body also takes a
  ~4% violet-tinted inset.
- **`info`** (blue) — tool cards and live tool-activity chips.
- **`error`** — failed tool cards and error notices.
- **`hairline-strong`** (neutral) — unknown/extension content: uncommitted.
- `success`/`warning` keep their status meanings (result icons, run states,
  the context gauge's caution tones).

### Discipline

- Neutral surfaces carry ≥95% of any screen; accent appears only where it
  communicates interaction or state, annotation hues only on block edges
  and icons.
- The dark teal is a small-area color: focus rings, selection edges, links,
  running dots, the gauge, and the compact `accent-fill` controls. It is
  never a panel background, banner fill, or large illustration color.
- Semantic colors (success/warning/error) appear only with a semantic
  meaning, tuned per theme, and never as decoration.
- All text/background pairs meet WCAG AA (4.5:1 body, 3:1 large or UI
  graphics) in both themes; `accent` on light and the annotation hues are
  3:1 graphics-only colors — small accent text must use `accent-deep`, and
  `faint` is tuned to stay ≥4.5:1 on `surface` in both themes.

## Typography

### Families

- **Sans — Noto Sans SC** (weights 400/500/600, self-hosted, one Latin and
  one CJK subset per weight): interface, transcript body, Chinese and Latin
  alike. The 2026-07-22 decision picked IBM Plex Sans SC, but IBM does not
  publish it to npm and no vendorable woff2 subset exists; Noto Sans SC is
  the same grotesque voice with first-class CJK, keeps the single-family,
  no-fallback-seam property, and ships from `@fontsource/noto-sans-sc`.
  Generic `sans-serif` closes the stack.
- **Serif — IBM Plex Serif**: the `insπre` wordmark only. No reading mode,
  no serif body text; the wordmark is Latin + π so no CJK serif is needed.
- **Mono — IBM Plex Mono** with the sans CJK face as its CJK fallback: code
  blocks, inline code, session IDs, paths, tool arguments and results.

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
- Topbar: 48px tall, canvas background, hairline bottom border.

### Whitespace philosophy

Medium density: the workbench shows structure without console clutter.
Separation prefers whitespace and hairlines over boxes-in-boxes; a surface
nests at most one level deep inside another surface (card → code block is
the maximum).

## Elevation & depth

- **Level 0** (`{elevation.level-0}`): everything resting in the layout —
  cards, composer, nav rows, code blocks. Hairline border, no shadow.
- **Level 1** (`{elevation.level-1}`): sticky/transient in-flow elements —
  jump-to-latest, banners.
- **Level 2** (`{elevation.level-2}`): floating surfaces — command palette,
  dialogs, pickers, notices.
- Dark theme conveys the same three levels with `surface` →
  `surface-raised` steps and `hairline-strong` edges instead of shadows.

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
  composer; abort keeps the same geometry with `error` semantics.

### Chips & badges

Pill chips (`{rounded.pill}`, `{typography.size-xs}`, 2px×9px padding) carry
run state, tool activity, queue counts, and statuses. Variants: muted
(hairline + `muted`), accent (running/selected: `accent` text with
`accent`-alpha border, filled `accent-fill` only for the primary run state),
warning/error/info via semantic colors. Chips are single-line, icon 12px.

### Workbench chrome

- **Header line** — all three regions (nav, topbar, context pane) share a
  48px header row with one continuous bottom hairline. The nav header holds
  the italic serif wordmark (π in KaTeX math italic) and the mock badge; the
  rail shows the math-italic π alone.
- **Topbar identity** — the session title (600) is the rename affordance
  (click to edit in place); beside it the project location renders in mono
  `{typography.size-xs}` `faint` — folder name or full path per the
  `projectDisplay` preference — and clicking it copies the absolute path.
  The model is never shown here.
- **Topbar actions** — nav toggle at the left; command palette, settings
  (opens the settings overlay), and context-pane toggle at the right. There
  is no compact button: users type `/compact [instructions]`, which the
  host routes to Pi's RPC compact command.

### Navigation

- Folder-first hierarchy: group headers at `{typography.size-base}`/600
  `muted` (chevron, folder icon, name, count) sit above session rows at
  `{typography.size-sm}`/400 `ink` indented one step, with a
  `{typography.size-xs}` `muted` meta line.
- Groups collapse freely — including the active session's group; a collapsed
  folder that hides the active session takes the `accent-tint` highlight and
  2px `accent` left edge itself. Active search overrides collapse.
- Row hover shows `surface-inset`; the active row shows `accent-tint` plus a
  2px `accent` inset edge; running/attention dots use `accent`,
  `success`, `error`.
- The pin action floats at the row's right edge and appears on hover/focus
  (always on touch); pinned sessions live in one global Pinned section.
- The **workspace explorer** sits at the nav's bottom edge: collapsed it is a
  single header bar (folder icon + project name + chevron); expanded it takes
  up to half the column with a lazily loaded tree derived from the host's
  project index (directories first), and clicking a file opens the
  session-bound preview pane.
- The nav column holds only brand, new-session, search, sessions, and the
  explorer — settings and refresh live in the topbar and palette
  respectively.

### Transcript

- **User bubble** — right-aligned, unlabeled, max-width 85% of the reading
  column, `accent-tint` background, `accent`-alpha hairline, `{rounded.lg}`,
  `{typography.size-md}` text; the full timestamp is the tooltip. Extra
  spacing before each user turn groups a prompt with its response.
- **Assistant flow** — no container: one attribution head line ("Pi" at
  `{typography.size-sm}`/600 with model, time, and any unusual end reason in
  `{typography.size-xs}` `faint`/`warning`) above an open document flow. The
  model appears exactly once per turn, and routine `stop` reasons are
  hidden. There is no footer meta line.
- **Thinking card / tool card / generic card** — one collapsible card
  anatomy: ~34px header row (icon 14px, label, one-line summary, status
  icon, chevron), `{rounded.md}`, `surface` background, hairline border,
  and a 3px annotation-colored left edge (`think` violet / `info` blue /
  `error` when failed / `hairline-strong` unknown) with the icon in the
  same hue. Thinking summaries are sans prose; tool summaries are mono;
  labels sit at `{typography.size-sm}` 600 (tool names mono 500). Expanded
  bodies are inset with a hairline top; thinking bodies take a faint violet
  tint.
- **Code block** — `surface` (dark: `surface-inset`) background, hairline
  border, `{rounded.md}`, header bar with language label
  (`{typography.size-xs}` `faint`) and copy action; code at
  `{typography.size-sm}`/`{typography.leading-mono}`. Syntax colors derive
  from the theme palette: accent for keywords, warning-adjacent for
  strings, `muted` for comments — max five hue roles.
- **Tables** — hairline row separators only, semibold header row, no zebra.
- **KaTeX** — display math gets 12px vertical margin, inner padding so tall
  glyphs clear the scroll container's clip edge, and horizontal scroll
  containment; never restyled glyphs.

### Composer

A level-0 surface at the reading column width: attachment/reference chip
rows on top, auto-growing textarea (`{typography.size-md}`, max 40vh), and
a meta row. Model and thinking level are quiet content-sized controls: a
`{typography.size-sm}` value plus 11px chevron with an invisible native
select stretched over the control, so the closed control hugs its value
while keyboard, dropdown, and accessible naming stay native. Model options
drop the provider prefix unless two providers share an id; thinking levels
read lowercase (`medium`, `xhigh`). At the right, the **context gauge** — a
14px ring plus percent in `{typography.size-xs}` — reports context-window
occupancy from Pi's session stats: calm `muted`/`accent` below 60%,
`warning` from 60%, `error` from 85%, with exact token counts and a
`/compact` reminder in the tooltip; it hides when Pi has no fresh usage
data (right after compaction). Focus shows a 2px `accent` ring on the whole
composer. Drop targeting tints the composer with `accent-tint` and a dashed
`accent` border.

### Command palette, settings & dialogs

Centered overlays at Level 2 on a 40%-alpha scrim; palette 560px wide,
`{rounded.lg}`, input row + grouped result list (group label
`{typography.size-xs}` uppercase tracked `faint`); active row `accent-tint`
with `accent` left edge. **Settings is an overlay dialog** (600px, scrolling
within 80dvh), not a page: sectioned cards for appearance (theme, project
location), card visibility, startup, and about; Escape and the scrim close
it, and Escape never leaks to the global abort shortcut. Extension dialogs
share the same surface with title at `{typography.size-lg}` semibold and
right-aligned action row.

### Notices & banners

Toast notices bottom-right at Level 2, `{rounded.md}`, semantic left edge
(3px), auto-dismiss; inline banners (error/reconnect) sit under the topbar
at Level 1 with `error-tint`/warning tint backgrounds and full-width
hairline.

### Focus & keyboard

`:focus-visible` shows a 2px `accent` outline with 2px offset on every
interactive element in both themes; no focus styling on plain mouse click.

## Motion

`{motion.micro}` for hover/focus/chip changes, `{motion.standard}` for card
collapse and palette/dialog entry (opacity + 4px translate),
`{motion.panel}` for nav/context slide. Spinners are the only looping
animation. Streaming text must never animate per-token; it appears by
layout only. `prefers-reduced-motion` reduces everything to opacity.

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

- No serif outside the wordmark; no reading-mode font switching.
- No weight 700+, no letter-spacing on CJK, no font-size improvisation
  outside the scale.
- No second decorative hue — the annotation palette is semantic, never
  ornament — no gradients, no glow, no large accent fills.
- No shadows on resting surfaces; no borderless floating cards.
- No per-component palette values, and no theme-specific component
  structure.

## Known gaps

None standing. The 2026-07-22 adoption installed this token layer in
`src/styles.css`, vendored the fonts under `src/assets/fonts` (SIL OFL
license texts beside them in `src/assets/licenses`), mapped highlight.js
token colors onto the palette roles, and removed the `readingSerif`
reading-mode preference end to end; Noto Sans SC replaced IBM Plex Sans SC
along the way (see Families). The 2026-07-23 redesign round replaced the
dark chartreuse with the luminous teal family, added the annotation
palette and workbench chrome contracts above, and set the wordmark in
italic serif with a KaTeX math π. Process history and decisions live in
the adoption stage.
