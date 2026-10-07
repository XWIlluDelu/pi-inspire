---
scope:
  - src/components/{Transcript,TranscriptUtilities,PromptMap}.tsx
  - src/components/transcript-fold.tsx
  - src/styles/transcript.css
  - tests/web/transcript-{fold,inspection}.test.tsx
  - tests/browser/reading-navigation.spec.ts
  - docdoki/specs/{conversation,workspace-layout,activity-presentation}.md
---

# Incremental frontend refinement

## Current state

Reading/navigation maintenance is accepted. Floating search, narrow launchers, Prompt Map and the
bottom-centered text `Jump to latest` retain their established layout. `TranscriptUtilities`
separates control presentation from existing search and viewport ownership.

Activity retains its original double rails, colored tool/Thinking segments, middle dots, geometry,
animations and turn dividers. The only interaction change is a single native button for the whole
collapsed stack: one hit area, one Tab stop and shared feedback. Open activity retains independent
upper/lower controls. Collapsing from below returns focus to the surviving disclosure without
scrolling. These maintenance changes are accepted as the baseline.

The frontend redesign round is closed. The user prefers the established overall design; the Files
layout experiment was withdrawn, and subsequent visual redesign proposals are not scheduled.
Further work should address demonstrated bugs, vulnerabilities or necessary maintenance rather
than restyling these surfaces.

## Ownership and verification

- `transcript-fold` shares rail rendering between presentational collapsed children and interactive
  open boundaries. Existing telemetry, density, adaptive timing, materialization and card-state
  owners are unchanged.
- `transcript.css` retains the original geometry and joins hover/focus feedback on the common
  disclosure. Keyboard focus uses one badge outline while both rails highlight together.
- Existing activity, inspection, paging and viewport tests passed during implementation. The
  focused new regression checks the single disclosure, activation through a presentational rail,
  and focus return with `preventScroll`.
- Existing browser workbench and floating-reading checks passed. Restored behavior reuses its
  prior evidence; no new visual or lifecycle test matrix is required for restoration.

## Next action

No further implementation is scheduled for this review. Preserve the established design.
