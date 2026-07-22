---
purpose: Pi’s typed messages, thinking, tools, and lifecycle events form one recoverable streaming conversation with independently controllable detail.
covers:
  - src/events.ts
  - src/store.ts
  - src/components/Transcript.tsx
  - src/components/ActivityBar.tsx
  - src/components/ExtensionUiDialog.tsx
  - server/runtime.ts
  - tests/web/events.test.ts
  - tests/web/store.test.ts
---

# Conversation experience

## Goal

Make the browser a complete, calm, and truthful presentation of an active Pi conversation.

## Checks

- User and assistant messages appear in source order without duplicate or missing settled content after reconnecting.
- User turns appear as compact bubbles while assistant answers use an open, left-aligned document flow suitable for long Markdown, mathematical notation, code, and structured activity.
- Assistant text streams smoothly without visually rebuilding the entire transcript for every fragment.
- Thinking appears separately from answer text and follows the user’s independent hidden, collapsed, or expanded preference.
- Each tool call is correlated with its live status, partial output, final result, and failure state.
- Tool activity uses compact cards by default while retaining an explicit path to complete arguments and output when safe to show.
- Unknown tools and extension messages receive a generic, lossless fallback instead of disappearing.
- The user can abort active work, send steering input during work, and queue follow-up input for after completion.
- Running, retrying, compacting, queued, aborted, failed, and settled states remain distinguishable.
- Refreshing the browser reconstructs settled conversation state from Pi and then resumes live updates.

## Non-goals

- Web cards do not have to reproduce ANSI rendering or terminal-only custom components.
- Raw provider payloads and credentials are not part of the browser conversation model.
