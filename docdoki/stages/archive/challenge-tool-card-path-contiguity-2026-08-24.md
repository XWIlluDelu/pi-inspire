---
scope:
  - playwright.config.ts
  - src/components/ResourcePathLabel.tsx
  - src/styles.css
  - tests/browser/tool-card-paths.spec.ts
  - tests/web/styles-contract.test.ts
  - tests/web/tool-cards.test.tsx
  - docdoki/specs/tool-presentations.md
---

# Tool card path contiguity

## Objective

Make resource paths remain visually complete whenever they fit and form one contiguous middle-truncated token when constrained, including real mobile Tool Card summaries.

## Current state

- **Fixed:** every resource path now uses one two-segment projection. The bounded filename tail keeps intrinsic width while the adjacent leading segment alone absorbs genuine overflow.
- **Verified:** browser checks use the production build and exact screenshot paths. Fitting, constrained summary, and expanded-block layouts all retain the complete accessible path, preserve the filename tail, and measure zero inter-segment or trailing gap.
- **Hardened:** Playwright explicitly binds its Mock Host to the current checkout so an inherited live installation root cannot substitute another worktree's build.

## Next actions

- [x] Replace breakpoint-selected full/compact projections with one actual-width two-segment projection.
- [x] Replace implementation-shaped regressions with behavioral checks covering fitting and constrained screenshot paths.
- [x] Reconcile the activity-presentation contract and verify the focused Web and browser paths.

## Decisions

- Remove the compact projection rather than tuning its percentages. The later full-path split already preserves the terminal filename tail at every width, so the older breakpoint workaround duplicates ownership and violates the complete-when-fitting contract.
- Use actual container width, not a card-width breakpoint, to decide whether path text truncates.
- Browser tests must serve the checkout under test even when the shell exports a different `INSPIRE_INSTALLATION_ROOT` for the live Host.

## Dead ends

- ❌ Percentage caps on context or tail — each cap can clip an otherwise fitting path and convert reclaimed flex width into a visible hole.
- ❌ A growing middle segment — an empty string remains a flex item and consumes free space without rendering identity.
- ❌ Trusting a passing worktree browser test without checking its served build — the inherited live installation root initially pointed the Mock Host back to main.
