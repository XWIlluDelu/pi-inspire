---
purpose: The high-level visual direction that keeps insπre a restrained scientific workbench; concrete tokens and component contracts live in the design-system spec.
covers:
  - index.html
  - src/**/*.tsx
  - src/styles.css
  - tests/web/app.test.tsx
---

# Visual language

## Goal

Give insπre a coherent front-end character that is calm enough for long
technical conversations, polished enough to replace the terminal as the
primary interface, and visually independent from its references.

## Checks

- The interface reads as a restrained scientific workbench through
  typography, hierarchy, spacing, and content structure rather than
  decorative formulas, diagrams, or laboratory motifs.
- The reference applications inform grammar, not identity: Claude Science’s
  restrained surface grammar (fine boundaries, soft radii, layered depth,
  content dominance) is kept, while its cream-and-coral personality is
  deliberately not reproduced; OpenAI4S remains a secondary reference for
  local-tool directness and practical information organization.
- Light and dark themes share one component architecture, default to the
  system preference, and preserve the same information hierarchy; light is
  the primary tuning target.
- Each theme carries exactly one brand accent family — the same teal hue
  in light and dark, tuned per theme for contrast on its surfaces — plus
  a small fixed set of semantic annotation hues (thinking violet, tool
  info blue, failure red) that mark meaning rather than decorate; the
  exact values, roles, and usage discipline are the [[design-system]]
  contract.
- One IBM Plex voice per role — Sans SC owns the interface and all reading
  flow (Latin and CJK in a single family), Serif exists only in the italic
  `insπre` wordmark whose π sets in the KaTeX math face, and Mono owns code
  and machine-oriented data with Sans SC as its Chinese fallback. There is no
  reading-mode font switch.
- All palette, type, spacing, radius, elevation, and motion values remain
  centralized as shared CSS tokens in `src/styles.css`, implementing the
  token table in [[design-system]]; components never hold local values.
- The `insπre` wordmark and π symbol remain small, stable identifiers
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
