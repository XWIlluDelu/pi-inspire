---
scope:
  - src/styles.css
  - tests/browser/tool-card-paths.spec.ts
  - tests/web/styles-contract.test.ts
  - docdoki/specs/tool-presentations.md
---

# Tool card path projection

## Objective

Restore truthful middle truncation in Tool Card resource summaries: a path that fits must remain complete, while constrained paths preserve their terminal filename identity without an unexplained blank gap.

## Current state

- **Completed:** the bounded terminal segment can claim its intrinsic width before leading context shrinks, so ordinary paths remain complete and genuinely constrained paths truncate through the middle.
- **Covered:** browser regressions exercise a long constrained expanded path and the short `src/styles.css` summary at desktop and compact card widths.

## Decisions

- Keep the component's existing 14-character bounded tail and CSS-native middle truncation. A percentage cap is incorrect because it clips ordinary basenames and converts the reclaimed flex width into a visible gap.
