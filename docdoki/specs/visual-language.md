---
purpose: The high-level visual direction that keeps Inspire a restrained scientific workbench; concrete tokens and component contracts live in the design-system spec.
covers:
  - index.html
  - src/**/*.tsx
  - src/styles.css
  - tests/browser/shell-layout.spec.ts
---

# Visual language

Inspire is a restrained scientific workbench for long technical conversations. Give the
conversation and its tools most of the space. Use typography, alignment and fine pane
boundaries to show their relationships. Keep medium information density and reveal secondary
controls on demand.

Copilot is the primary reference for pane hierarchy and quiet chrome. ChatGPT and Codex
inform local-tool interactions. Inspire has its own palette, type, artwork and component
implementation. The `INSΠRE` wordmark and Open Reticle are small, stable identifiers.

Light is the primary tuning target. Light and dark follow the system preference by default
and share navigation, components and information hierarchy. Tune surfaces and accent inks
for each palette while keeping status meanings consistent. Motion should explain a state
or position change, stay responsive during streaming and respect reduced-motion preferences.

[[design-system]] defines the available palettes, typography, interaction states and shared
tokens in `src/styles/foundation.css`. Use those roles across components.
