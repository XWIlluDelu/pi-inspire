---
purpose: The high-level visual direction that keeps Inspire a restrained scientific workbench; concrete tokens and component contracts live in the design-system spec.
covers:
  - index.html
  - src/**/*.tsx
  - src/styles.css
  - tests/web/app.test.tsx
---

# Visual language

## Goal

Give Inspire a coherent front-end character that is calm enough for long
technical conversations, polished enough to replace the terminal as the
primary interface, and visually independent from its references.

## Visual principles

- The interface reads as a restrained scientific workbench through
  typography, hierarchy, spacing, and content structure rather than
  decorative formulas, diagrams, or laboratory motifs.
- Reference applications inform grammar, not identity. Copilot's workbench character is the
  primary reference: quiet chrome, clear pane hierarchy, fine boundaries, and content dominance.
  ChatGPT and Codex inform a restrained finish and straightforward local-tool interactions,
  not a second component identity or a copied palette.
- Light and dark themes share one component architecture, default to the
  system preference, and preserve the same information hierarchy; light is
  the primary tuning target.
- The botanical themes each carry one brand family: Wisteria mineral purple,
  Hydrangea celadon green, Lycoris mineral coral, or Chimonanthus honey amber (the default),
  tuned independently in light and dark. Tinted paper surfaces extend from the sidebar
  into prompts, code and reading areas; light Composer and raised surfaces stay white.
  Solid fills, readable accent ink and activity identity shades have distinct roles.
  Components use the shared focus role: botanical palettes map it to their main accent,
  while classic Jade and Amber retain their accent-ink focus. Selected sessions use a theme
  tint without an extra frame. Classic Jade and Amber remain selectable with their
  characteristic surfaces and accents.
  Tool and Thinking identity use palette-aware ink, separate from success, warning, failure and
  information status. [[design-system]] owns these roles and their usage.
- IBM Plex Sans SC owns the interface, reading flow and uppercase `INSΠRE` wordmark, with Latin
  and CJK in one family. Flux Mono SC owns code and machine-oriented data, including Chinese code
  comments. Rajdhani supplies a compact mechanical voice for structural labels (Activity, resource
  modes and Settings sections), not body text or ordinary controls. There is no reading-mode font
  switch; [[design-system]] defines the type roles and bundled assets.
- All palette, type, spacing, radius, elevation, and motion values remain
  centralized in `src/styles/foundation.css`, loaded through the ordered `src/styles.css`
  entrypoint. [[design-system]] defines their roles; components do not invent local palette values.
- The `INSΠRE` wordmark and Open Reticle mark remain small, stable identifiers
  rather than recurring decorative motifs.
- Motion explains state, continuity, or spatial change, stays responsive
  during streaming, and respects reduced-motion preferences.
- The interface maintains medium information density and uses progressive
  disclosure instead of either sparse consumer-chat minimalism or an
  always-expanded control-panel presentation.

## Non-goals

- The visual system does not copy any reference application’s palette,
  typography assets, artwork, or GUI code.
- Light and dark themes do not become separate product personalities with
  different navigation or component behavior; per-theme tuning of the
  shared accent and annotation hues is the only sanctioned difference.
