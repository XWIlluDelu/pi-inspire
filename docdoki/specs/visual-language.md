---
purpose: A Claude Science-led visual system gives insπre a restrained scientific-workbench character while keeping conversation content dominant, locally direct, and visually independent from its references.
covers:
  - index.html
  - src/**/*.tsx
  - src/styles.css
  - tests/web/app.test.tsx
---

# Visual language

## Goal

Give insπre a coherent front-end character that is calm enough for long technical conversations, polished enough to replace the terminal as the primary interface, and recognizable without decorative scientific theming.

## Checks

- The interface reads as a restrained scientific workbench through typography, hierarchy, spacing, and content structure rather than decorative formulas, diagrams, or laboratory motifs.
- Claude Science is the primary visual benchmark for typography roles, component surfaces, borders, radii, shadows, and overall finish; OpenAI4S is a secondary reference for local-tool directness, command interaction, and practical information organization.
- Light and dark themes share one component architecture, default to the system preference, and preserve the same information hierarchy.
- Body text, controls, and assistant responses use a sans-serif family by default in both themes; serif type is reserved for the wordmark and an optional reading style; code and machine-oriented data use a monospaced family.
- Neutral surfaces carry most of the interface, one restrained primary accent directs interaction, and additional colors appear only when they communicate necessary semantics; light and dark palette values remain centralized as shared CSS tokens rather than component-local choices.
- Component surfaces follow Claude Science’s visual grammar: fine boundaries, soft radii, restrained layered shadows, and clear depth without heavy floating-card effects.
- The `insπre` wordmark and π symbol remain small, stable identifiers rather than recurring decorative motifs.
- Motion explains state, continuity, or spatial change. Richer motion is acceptable only when it remains responsive, does not disturb streaming or scrolling, and respects reduced-motion preferences.
- The interface maintains medium information density and uses progressive disclosure instead of either sparse consumer-chat minimalism or an always-expanded control-panel presentation.

## Non-goals

- The visual system does not reproduce Claude Science or OpenAI4S pixel for pixel.
- Reference typography, artwork, proprietary assets, and ambiguously licensed GUI code are not copied.
- Light and dark themes do not become separate product personalities with different navigation or component behavior.
