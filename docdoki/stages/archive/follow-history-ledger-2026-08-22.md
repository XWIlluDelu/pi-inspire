---
scope:
  - docdoki/specs/workbench.md
  - src/components/BranchTree.tsx
  - src/styles.css
  - tests/web/branch-tree.test.tsx
---

# Turn-aware history ledger

## Objective

Make History useful first as branch and time-point navigation, while retaining a compact audit path for raw Pi entries. Replace raw ancestry indentation and an always-flat entry stream with a turn-aware, searchable, progressively disclosed ledger suited to the contextual pane.

## Current state

- **Working:** Pi remains the authority for ordered entry identity, active ancestry, durable/effective leaves, and supported switch, edit, and fork actions.
- **Completed:** History now projects the bounded entry tree into prompt-anchored turns, preserves exact entry actions under progressive disclosure, and exposes shallow branch lanes, current/latest/alternate state, search, and global folding without raw-depth width loss.
- **Reference:** DeepSeek Harness's MIT-licensed Trajectory view validates turn-aware grouping, stable kind/content columns, search, folding, explicit selection, and honest loaded-window boundaries as transferable methods; its full-width timing overview and payload inspector do not fit this narrower operational surface or the data currently projected by INSΠRE.

## Next actions

- [x] Project loaded entries into prompt-anchored turn groups with indentation based on actual branch divergence rather than raw ancestry depth.
- [x] Add search, global folding, compact event summaries, current/latest/alternate states, and local prompt actions without weakening stale-projection guards.
- [x] Keep exact entry navigation available through expanded event rows and state the bounded-history boundary honestly.
- [x] Verify interaction, accessibility, narrow-pane geometry, and the existing branch mutation paths in focused tests and a real browser.
- [x] Update the workbench authority and archive this stage.
- [x] Commit only this work stream after the concurrent transcript commit releases the shared Git index.

## Decisions

- History is not a second transcript or a full clone of DSH Trajectory: its default layer is the conversation's operational turn/branch map, and raw entries are progressive audit detail.
- Preserve chronological append order and Pi action semantics; grouping, folding, search, and branch lanes are presentation-only projections.
- Role styling remains subordinate to current/alternate/error state rather than reusing success and warning colors as decorative role colors.
- Keep the existing bounded host response for this pass; surface truncation explicitly instead of fabricating complete history or adding an unproven second pagination contract.

## Checks

- `npm test -- --run tests/web/branch-tree.test.tsx` — 5 focused interaction/projection tests pass, including a 500-entry bounded tree.
- `npm run lint` and `npm run typecheck` — pass for the shared working tree.
- Production web build plus real Chromium at 1440×900 and 390×844 — turn folding, branch-lane geometry, current/latest state, and narrow drawer presentation verified with no horizontal overflow.
- Axe on the rendered History surface — no violations in either light or dark Amber themes.
