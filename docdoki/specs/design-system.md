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
    faint: "#838c88"
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
  colors-dark:
    canvas: "#131615"
    surface: "#1a1e1d"
    surface-raised: "#222726"
    surface-inset: "#101312"
    hairline: "#2e3533"
    hairline-strong: "#3d4643"
    ink: "#e8ebea"
    body: "#cdd3d1"
    muted: "#8f9996"
    faint: "#667069"
    accent: "#d8f03c"          # lime-400, industrial chartreuse anchor (links, focus, selection, running)
    accent-hover: "#e7f76a"
    accent-fill: "#bfd52f"     # lime-500, filled controls with on-accent text
    accent-deep: "#d8f03c"     # same as accent: already ≥13:1 on dark surfaces
    accent-active: "#9db023"
    accent-tint: "rgba(216, 240, 60, 0.10)"
    on-accent: "#141a06"
    success: "#6dbb8a"
    warning: "#d9a94a"
    error: "#e07b74"
    error-tint: "rgba(224, 123, 116, 0.12)"
  typography:
    sans: "'IBM Plex Sans SC', 'IBM Plex Sans', sans-serif"
    serif: "'IBM Plex Serif', serif"          # wordmark only
    mono: "'IBM Plex Mono', 'Noto Sans Mono CJK SC', monospace"
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
    context-width: 320px
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
accent per theme, and IBM Plex as the single type voice for interface,
Chinese text, and code. Content — Markdown, KaTeX mathematics, highlighted
code — carries the character; chrome stays quiet.

The two themes share one component architecture and one information
hierarchy. Their only deliberate personality difference is the accent hue:
**teal `{colors-light.accent}` in light**, **industrial chartreuse
`{colors-dark.accent}` in dark**. Everything else (structure, spacing, type,
motion) is theme-invariant. Light is the primary tuning target; dark follows
it and is verified, not separately designed.

Key characteristics:

- Paper-not-cream neutrals: the light canvas is a cool-green-tinted white,
  deliberately away from both Anthropic cream and dev-tool blue-gray.
- One accent family per theme with named roles (`accent`, `accent-fill`,
  `accent-deep`, `accent-tint`); no second decorative hue.
- IBM Plex Sans SC everywhere, so Chinese and Latin share one family with no
  fallback seam; serif exists only in the `insπre` wordmark; Plex Mono owns
  code and machine data with a CJK mono fallback for aligned comments.
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
  controls, links in dark theme.
- **`accent-fill`** — the only filled-control background (primary button,
  send button, active chip). Text on it is `on-accent`. Chosen one step
  deeper than `accent` in light so white text passes 4.5:1.
- **`accent-deep`** — small accent text on light surfaces (links, inline
  emphasis); equals `accent` in dark where contrast is already ample.
- **`accent-tint`** — low-alpha wash for selected rows, drop targets, and the
  user bubble background.

### Discipline

- Neutral surfaces carry ≥95% of any screen; accent appears only where it
  communicates interaction or state.
- The dark chartreuse is a small-area color: focus rings, selection edges,
  links, running dots, and the compact `accent-fill` controls. It is never a
  panel background, banner fill, or large illustration color.
- Semantic colors (success/warning/error) appear only with a semantic
  meaning, tuned per theme, and never as decoration.
- All text/background pairs meet WCAG AA (4.5:1 body, 3:1 large or UI
  graphics) in both themes; `accent` on light is a 3:1 graphics-only color —
  small accent text must use `accent-deep`.

## Typography

### Families

- **Sans — IBM Plex Sans SC** (weights 400/500/600, self-hosted, subset):
  interface, transcript body, Chinese and Latin alike. `IBM Plex Sans` may
  serve as a Latin-first sibling ahead of the SC face; generic `sans-serif`
  closes the stack.
- **Serif — IBM Plex Serif**: the `insπre` wordmark only. No reading mode,
  no serif body text; the wordmark is Latin + π so no CJK serif is needed.
- **Mono — IBM Plex Mono** with `Noto Sans Mono CJK SC` fallback: code
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

### Navigation

- Session rows: full-width, `{rounded.md}`, title at
  `{typography.size-base}`/500 + meta line at `{typography.size-xs}`
  `muted`; hover `surface-inset`; active row `accent-tint` background with a
  2px `accent` inset edge at the left; running dot in `accent`.
- The nav footer holds preference controls as quiet labeled fields; the
  wordmark block is the only serif on screen.

### Transcript

- **User bubble** — right-aligned, max-width 85% of the reading column,
  `accent-tint` background, `accent`-alpha hairline, `{rounded.lg}`,
  `{typography.size-md}` text.
- **Assistant flow** — no container: an open document flow on canvas, left
  aligned, with a `{typography.size-xs}` `muted` attribution line above and
  meta line below.
- **Thinking card / tool card / generic card** — one collapsible card
  anatomy: 32px header row (icon 14px, label, one-line `muted` summary,
  status icon, chevron), `{rounded.md}`, `surface` background, hairline
  border. Thinking uses a brain icon and renders Markdown at
  `{typography.size-sm}`; tool cards show `mono` name, argument summary,
  and result in `mono` `{typography.size-sm}` with error state coloring the
  status icon and result edge `error`; unknown content uses the generic
  card with lossless JSON. Expanded bodies are inset with a hairline top.
- **Code block** — `surface` (dark: `surface-inset`) background, hairline
  border, `{rounded.md}`, header bar with language label
  (`{typography.size-xs}` `muted`) and copy action; code at
  `{typography.size-sm}`/`{typography.leading-mono}`. Syntax colors derive
  from the theme palette: accent for keywords, warning-adjacent for
  strings, `muted` for comments — max five hue roles.
- **Tables** — hairline row separators only, semibold header row, no zebra.
- **KaTeX** — display math gets 12px vertical margin and horizontal scroll
  containment; never restyled glyphs.

### Composer

A level-0 surface at the reading column width: attachment/reference chip
rows on top, auto-growing textarea (`{typography.size-md}`, max 40vh), and
a meta row (attach, project files, model and thinking selects as quiet
borderless selects, project name, send/abort). Focus shows a 2px `accent`
ring on the whole composer, not the inner textarea. Drop targeting tints
the composer with `accent-tint` and a dashed `accent` border.

### Command palette & dialogs

Centered overlay at Level 2 on a 40%-alpha scrim; palette 560px wide,
`{rounded.lg}`, input row + grouped result list (group label
`{typography.size-xs}` uppercase `faint`); active row `accent-tint` with
`accent` left edge. Extension dialogs share the same surface with title at
`{typography.size-lg}` semibold and right-aligned action row.

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
- Keep the chartreuse small: if a dark-theme accent area exceeds a chip or
  a 2px edge, use `accent-tint` instead.
- Let long technical answers dominate: chrome may not compete with content
  for contrast.
- Verify both themes by screenshot after any component change; light is
  tuned first, dark checked immediately after.

### Don't

- No serif outside the wordmark; no reading-mode font switching.
- No weight 700+, no letter-spacing on CJK, no font-size improvisation
  outside the scale.
- No second decorative hue, no gradients, no glow, no large lemon fills.
- No shadows on resting surfaces; no borderless floating cards.
- No per-component palette values, and no theme-specific component
  structure.

## Known gaps

- The current implementation still uses the draft palette, Inter-era system
  stack, and the `readingSerif` preference; adoption is tracked in the
  active design-system stage.
- IBM Plex fonts are not yet vendored; self-hosting with CJK subsetting is
  part of adoption.
- KaTeX and highlight.js theme variables must be mapped to these tokens
  during adoption.
