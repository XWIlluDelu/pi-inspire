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

Bring the implementation up to the new [[design-system]] contract: IBM Plex
type stack, per-theme accents (teal `#00928c` light / chartreuse `#d8f03c`
dark), token-routed styles, and the simplified feature surface.

## Current state

- The design-system spec is authored and is the design authority; the
  spec abstract and visual-language spec are aligned to it.
- The implementation still runs the draft MVP look: Inter-era system font
  stack, draft palette, and the `readingSerif` preference. Known drift,
  tracked here; the spec’s Known gaps section names the same items.

## Next actions

- Remove the reading mode end to end (decided 2026-07-22, feature
  simplification): `readingSerif` in `shared/contracts.ts`,
  `server/preferences.ts` schema, store setters, Nav and CommandPalette
  controls, `data-reading` handling in `App.tsx` and `src/styles.css`, and
  the preferences tests that exercise it.
- Vendor IBM Plex Sans SC / Serif / Mono (subset, self-hosted, no CDN) and
  install the token layer from the design-system frontmatter into
  `src/styles.css` as the single implementation authority.
- Restyle components to the spec’s anatomy (buttons, chips, nav rows,
  transcript cards, composer, palette, dialogs, notices) and map KaTeX and
  highlight.js theme variables onto the tokens.
- Verify by screenshot in both themes (light first) against the spec’s
  checks; keep the accessibility and interaction tests green.

## Decisions

- Fonts: IBM Plex Sans SC (interface + CJK), IBM Plex Serif (wordmark
  only), IBM Plex Mono (+ Noto Sans Mono CJK SC fallback); chosen from
  rendered pairing comparisons on 2026-07-22.
- Accents: light anchors on user-chosen teal `#00928c`; dark anchors on
  chartreuse `#d8f03c` (user direction "industrial lemon", green-shifted
  variant selected from dark-theme samples). One accent per theme is the
  only sanctioned theme personality difference.
- Reading mode is removed rather than re-fonted: no product need, and it
  was the only surface demanding a CJK serif.
- Scope is spec-first: this stage tracks adoption; no implementation change
  has been made yet.
