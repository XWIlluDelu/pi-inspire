---
scope:
  - docdoki/specs/design-system.md
  - docdoki/specs/visual-language.md
  - index.html
  - src/**
  - shared/contracts.ts
  - server/preferences.ts
  - tests/web/**
---

# Design system adoption

## Objective

Bring the implementation up to the [[design-system]] contract — per-theme
accents (teal `#00928c` light / chartreuse `#d8f03c` dark), token-routed
styles, vendored fonts, the simplified feature surface — and, riding the same
pass, replace the draft workbench chrome with the polished interface the
contract describes.

## Current state

Adopted and verified 2026-07-22. The token layer in `src/styles.css` is the
single styling authority and implements the design-system frontmatter
values; components consume tokens only. Fonts are vendored under
`src/assets/fonts` (latin + CJK subsets, `font-display: swap`; SIL OFL texts
in `src/assets/licenses`). Light and dark themes verified by mock-host
screenshots; `npm run check` is green (typecheck + 125 tests).

Riding the same pass, the draft chrome was redesigned:

- Transcript: the assistant turn label no longer repeats the model (the
  meta line is the single place it appears), routine `stop` end reasons are
  hidden, expanded cards drop their one-line summary, and prose summaries
  use the sans face while machine summaries stay mono.
- Topbar: the session title itself is the rename affordance (click to edit
  in place); the separate pencil button is gone.
- Welcome: one inline composer starts a session with its first message; the
  project directory lives in its meta row (empty means the current
  project). Continue-previous and recent sessions remain one click away.
- Settings: the `Draft` badge and the reading-mode field are gone; an About
  section reports the host version. Code-block copy is an icon action.
- `readingSerif` is removed end to end (contracts, server schema, store,
  palette, settings, tests). Stored preference files carrying the key still
  parse — the server schema strips unknown keys.

A second, user-directed redesign round rode the same stage on 2026-07-23:

- Dark palette: chartreuse replaced by the luminous teal family
  (`#4dd8cd` accent line) over warmer green-gray surfaces; key contrasts
  re-verified numerically (body ~11:1, muted ~6:1, faint ≥4.2:1).
- Annotation palette: thinking violet, tool info blue, failure red — one
  3px left-edge grammar shared by activity cards and notices.
- Transcript: a single attribution head line per assistant turn (model
  named once, routine `stop` hidden), unlabeled user bubbles.
- Composer: quiet content-sized model/effort controls (invisible native
  select stretched over a visible value), lowercase thinking levels, and
  a circular context gauge — occupancy-colored, `/compact` hint in its
  tooltip — replacing the compact button.
- `/compact [instructions]` typed anywhere is intercepted at the host
  prompt boundary and issued as the RPC compact control, because Pi's RPC
  `prompt` parses only extension commands, not built-ins.
- Topbar: project location beside the rename-in-place title (folder name
  or full path per a global preference; click copies the absolute path
  with no layout shift); settings moved to a gear-opened floating
  overlay; the wordmark set in italic serif with a KaTeX-math π.
- Nav: brand rail, folder group headers above smaller session rows, a
  collapsed group carrying the visible session shows the active highlight
  on its header, quieter pin affordance, and a collapsible workspace
  explorer over the session's project index in the column's lower half.
- Resource preview boundary widened to transcript references plus project
  index membership; index authority stops at the workspace realpath
  boundary, so a git-indexed symlink cannot open an outside file.
- Welcome: the continue-previous card is gone; the recent-sessions list
  is collapsible; the start composer takes an optional project directory.
- Math scripts rendered near full size because the root `katex` (0.18.1,
  CSS-only use) had drifted from the `katex` 0.16 that `rehype-katex`
  renders with — KaTeX 0.18 namespaced its CSS classes (`sizing` →
  `katex-sizing`), so the 0.16 markup matched no sizing rule. Root katex
  is pinned to `^0.16.47` so one deduped instance supplies both the
  renderer and the stylesheet; superscripts measure exactly 0.7× again.

A detail-polish round followed on 2026-07-24 (layout deliberately
unchanged — a full restyle was sampled in four rendered directions and
declined in favor of the current typography):

- Content safety: rich-text images clamp to the column, wide tables
  scroll internally, long words/paths wrap in prose and user bubbles.
- Micro-interactions: disclosure chevrons rotate instead of swapping
  glyphs, card bodies fade in on expand, buttons give press-scale
  feedback, a quiet accent caret marks streaming text.
- Small UX: visible text selection color per theme, larger code-copy hit
  area, session-row/recent-row tooltips for truncated titles, palette
  keyboard navigation keeps the active row in view, scroll containers use
  overscroll containment, the tab title falls back to the session name,
  and the attribution line's model/time render in mono.

After the round, `npm run check` is green: typecheck plus 137 tests
across 18 files, and both themes were re-verified by mock-host
screenshots.

## Next actions

None standing. Future theme tuning happens inside the token layer; new
components should be checked against both themes by screenshot.

## Decisions

- Fonts: Noto Sans SC (interface + CJK, weights 400/500/600), IBM Plex
  Serif (wordmark only), IBM Plex Mono (code). The 2026-07-22 plan chose
  IBM Plex Sans SC, but it is not published to npm (`@fontsource` has no
  such package, verified 2026-07-22), so no vendorable web subset exists
  there; Noto Sans SC is the same grotesque voice, keeps the
  single-family no-seam property, and is vendored from
  `@fontsource/noto-sans-sc` (latin + chinese-simplified subsets per
  weight).
- Accents: light anchors on user-chosen teal `#00928c`; dark anchors on
  chartreuse `#d8f03c` (user direction "industrial lemon", green-shifted
  variant selected from dark-theme samples). One accent per theme is the
  only sanctioned theme personality difference.
- Reading mode is removed rather than re-fonted: no product need, and it
  was the only surface demanding a CJK serif.
- The first paint resolves the system theme via `public/theme-init.js`
  (external file so the host CSP `script-src 'self'` accepts it); explicit
  user choices are applied by the app at bootstrap.
- Scope was spec-first: this stage tracked adoption before the
  implementation pass; the interface redesign rode the same pass because
  the draft chrome was the gap the contract described.
- Dark accent revision (2026-07-23): chartreuse fought the green-gray
  neutrals and read harsh beside long text, so dark now anchors on the
  same teal hue as light, raised to `#4dd8cd` for dark surfaces. This
  supersedes the per-theme-hue decision above — the sanctioned theme
  difference is tuning, not hue.
- The annotation hues exist to answer a user need (telling thinking, tool,
  and failed blocks apart at a glance); they are semantic markers with a
  fixed grammar, not a second decorative family.
- Compact is a typed command, not a button: Pi's RPC `prompt` does not
  parse built-in slash commands, so both runtimes intercept `/compact`
  at the prompt boundary; the freed composer slot surfaces the context
  occupancy the session stats already carried.
- The workspace explorer reuses the project index as its only authority —
  no filesystem resolution of requested directories — and the preview
  resolver accepts exactly that index beside transcript references, so
  browsing and previewing share one boundary.
