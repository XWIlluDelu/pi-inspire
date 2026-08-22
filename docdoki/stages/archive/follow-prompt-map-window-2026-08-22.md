---
scope:
  - src/components/Transcript.tsx
  - src/components/PromptMap.tsx
  - src/styles.css
  - server/mock.ts
  - tests/web/prompt-map.test.tsx
  - tests/browser/workbench.spec.ts
  - docdoki/specs/conversation.md
---

# Prompt map window

## Objective

Keep the collapsed Prompt Map compact and truthful for long conversations while making its expanded user-input directory genuinely scrollable.

## Current state

Complete. The collapsed map now presents a stable one-to-one local window, the authoritative Transcript bottom selects the final prompt, and the expanded virtual directory owns a bounded independent scrollport.

## Next actions

- [x] Project at most 12 fixed-spacing marks as a stable consecutive window around the active prompt.
- [x] Pin the active prompt to the final turn only at the authoritative Transcript latest boundary.
- [x] Give the expanded virtual directory a bounded, keyboard- and pointer-scrollable list without scroll bleed or position theft.
- [x] Cover long/tall histories, sequential and distant navigation, appends, and narrow layouts in focused browser tests.
- [x] Reconcile the Conversation contract and archive this stage.

## Decisions

- At most 12 fixed-height, fixed-spacing marks are shown. With more prompts they represent a local consecutive window, not global percentage buckets.
- Previous and Next continue to traverse the complete current branch and do not wrap.
- The expanded directory retains a fixed maximum height and exposes every prompt through virtual scrolling rather than growing indefinitely.
- Sequential movement preserves the current local window until the active prompt crosses an edge; distant seeks recenter it, and appends do not pull a reader away from an older window.
- Explicit prompt navigation continues to own the current turn until manual Transcript input; exact latest-boundary detection applies only to a genuinely scrollable Transcript that contains the final indexed turn.

## Validation

- 861 repository tests and 3 launcher tests passed.
- All 14 real-browser tests passed, including a 13-prompt fixture at 1280×1400 and 390×780.
- Type checking, formatting, lint, unused-code analysis, and the production build passed.
