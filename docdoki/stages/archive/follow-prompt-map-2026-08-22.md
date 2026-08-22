---
scope:
  - shared/contracts.ts
  - server/session-projection.ts
  - server/runtime.ts
  - server/app.ts
  - src/api.ts
  - src/store.ts
  - src/components/Transcript.tsx
  - src/components/transcript-viewport.ts
  - src/components/PromptMap.tsx
  - src/styles.css
  - tests/server/**
  - tests/web/**
  - tests/browser/**
---

# Prompt map

## Objective

Add a transcript-edge prompt map that gives complete, current-branch navigation over visible user turns without loading hidden assistant activity or duplicating History's branch and time-travel role.

## Current state

- Complete: Prompt Map is implemented and validated across the Host projection, browser Store, virtual Transcript, and responsive workbench.
- Modified files: none after archive.

## Next actions

- [x] Establish one bounded, branch-view-bound user-turn index and direct seek contract.
- [x] Implement store ownership, append/rewrite reconciliation, and unloaded-turn navigation.
- [x] Add the desktop transcript-left rail, prompt list, previous/next controls, current-turn tracking, disabled states, and narrow-workbench adaptation.
- [x] Validate long histories, branches, lazy activity, virtual scrolling, keyboard/accessibility, themes, and responsive layouts.
- [x] Reconcile the standing Conversation and Workbench contracts, then archive this stage.

## Decisions

- The map contains only user turns visible on the current branch; persisted steering and follow-up input counts when it is an ordinary visible user turn.
- It is a read-only conversation outline. History remains the owner of alternate paths and Switch/Edit/Fork operations.
- The complete outline cannot depend on currently loaded Transcript pages or History's bounded raw-entry window.
- Navigation to an unloaded turn must seek directly around a stable turn anchor and must not materialize folded Thinking/Tool activity.
- A fixed previous control at the top and next control at the bottom move between user turns without wrapping; unavailable states use native disabled semantics and subdued token-driven presentation.

## Validation

- `npm run check` — passed: formatting, lint, typecheck, unused-code checks, production build, 847 focused/unit/integration tests, and 3 launcher tests.
- `npm run test:browser` — passed: 13 Chromium workbench tests, including desktop and 390px Prompt Map navigation, disabled-state contrast, and 44px touch targets.
- Real-browser desktop and 390px review confirmed the opaque expanded map, virtual prompt summaries, fixed boundary controls, current-item indication, and non-overlapping narrow-screen controls.

## Log

- 2026-08-22: Added after design review established that Prompt Map is a current-branch reading navigator, not a second History tree.
- 2026-08-22: Implemented the complete index, random-access paging, sparse Transcript merging, viewport ownership, virtual map, responsive presentation, and previous/next boundary controls; validated and archived.
