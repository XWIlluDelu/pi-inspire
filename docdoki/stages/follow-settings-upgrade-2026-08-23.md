---
scope:
  - shared/contracts.ts
  - server/preferences.ts
  - src/App.tsx
  - src/components/Settings.tsx
  - src/store.ts
  - src/styles.css
  - tests/server/preferences.test.ts
  - tests/web/app.test.tsx
---

# Settings upgrade

## Objective

Upgrade INSΠRE's Settings functionality. Define the exact product scope and acceptance contract before implementation.

## Progress

- [x] Defined and implemented modular semantic block architecture for Settings (`Appearance`, `Transcript`, `Attention`, `Startup`, `Install`, `About`).
- [x] Built responsive dual-pane Master-Detail navigation with ordinary category-navigation semantics, section scroll-spy, and a mobile horizontal pill rail.
- [x] Added instant in-modal search with multi-dimensional keyword filtering, category navigation that restores filtered sections before scrolling, and Escape-to-clear before modal close.
- [x] Enhanced visual design with restrained scientific workbench aesthetics, card grouping, tactile segmented controls, and theme integration.
- [x] Preserved modal focus ownership and added focused Settings navigation/search coverage.

