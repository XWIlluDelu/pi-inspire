---
scope:
  - docdoki/specs/conversation.md
  - shared/contracts.ts
  - server/preferences.ts
  - src/App.tsx
  - src/store.ts
  - src/components/Settings.tsx
  - src/components/CommandPalette.tsx
  - src/components/Transcript.tsx
  - src/components/transcript-activity.ts
  - src/components/transcript-fold.tsx
  - src/components/transcript-rows.tsx
  - src/events.ts
  - src/styles.css
  - tests/server/**
  - tests/web/**
---

# Response activity folds

## Objective

Let users hide or inspect the unchanged Thinking, Tool, and other assistant activity between visible response passages through a full-width, two-rail fold that preserves the existing transcript experience when open.

## Outcome

- Transcript projection now groups every maximal visible non-response run into one fold without changing the existing Thinking, tool, custom, generic, copy, search, or round renderers inside it.
- The persistent Activity folds preference offers Dynamic, Expanded, Compact, and Collapsed in Settings and the command palette, with Dynamic as the migration-safe default.
- Expanded folds retain their complete card state between two independently clickable rails. Compact keeps the latest 24 cards and, only when needed, places an expandable `···` before them; Collapsed retains the underlying content while showing only centered `···`. The same minimal omission control owns deferred loading and retry instead of exposing a separate text card.
- Dynamic folds start Compact while host or displayed-custom liveness can still add activity, then close after the next response boundary or an authoritative terminal state. Manual disclosure wins, disconnect alone does not close, and runtime failure clears stale browser-only streaming and tool state.
- Focused projection, timing, custom-activity, manual-state, terminal, preference, reducer, and migration tests pass. Production build and desktop/mobile real-browser checks show two full-width rails, no horizontal overflow, and no browser console errors.
- The standing contract is recorded in [[conversation]].

## Decisions

- A fold wraps every existing non-response assistant activity region; it does not alter the cards or content rendered inside.
- Expanded, Compact, and Collapsed are stable defaults, not interaction locks. Manual disclosure follows Collapsed → Compact → Expanded and the reverse density ladder, skipping Compact only when it is visually equivalent to Expanded; Dynamic uses Compact while live and otherwise closes after the established dwell.
- Browser transport loss alone is not a terminal signal. Reconnection uses the authoritative host snapshot; `agent_settled`, terminal run state, runtime failure, and completed live custom activity are valid closure evidence.
- The visual object is a full-width band with separate upper and lower rails, not a card and not a single interrupted line.
