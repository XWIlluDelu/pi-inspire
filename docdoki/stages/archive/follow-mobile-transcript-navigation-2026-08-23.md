---
scope:
  - src/components/PromptMap.tsx
  - src/components/Transcript.tsx
  - src/styles.css
  - tests/web/prompt-map.test.tsx
  - tests/web/transcript-inspection.test.tsx
  - tests/browser/workbench.spec.ts
  - docdoki/specs/conversation.md
  - docdoki/specs/workbench.md
---

# Mobile transcript navigation

## Objective

Replace the narrow-workbench Prompt Map rail and unusable collapsed search with one transparent control floating over Transcript without reserving layout height. Its idle state exposes Search and Prompt Map launchers; Search and a 90-degree-rotated Prompt Map each take over that floating zone explicitly, and the Prompt Map retains its complete virtual directory.

## Progress

- [x] Confirmed in a 390 × 844 browser that the fixed vertical Prompt Map overlaps the transcript and that the collapsed search cannot focus its `display: none` input.
- [x] Added explicit, mutually exclusive mobile Search and Prompt Map modes without changing desktop behavior.
- [x] Preserved full Prompt Map navigation, local-window identity, complete directory access, and search viewport ownership.
- [x] Validated touch targets, narrow layout, scrolling, focus, dismissal, and desktop regression boundaries.
