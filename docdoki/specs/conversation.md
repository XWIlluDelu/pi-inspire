---
purpose: Pi’s typed messages, thinking, tools, and lifecycle events form one recoverable streaming conversation with independently controllable detail.
covers:
  - src/ansi.ts
  - src/App.tsx
  - src/events.ts
  - src/store.ts
  - shared/contracts.ts
  - src/components/RichText.tsx
  - src/components/Transcript.tsx
  - src/components/ActivityBar.tsx
  - src/components/BranchTree.tsx
  - src/components/ExtensionUiDialog.tsx
  - server/runtime.ts
  - tests/web/ansi.test.tsx
  - tests/web/events.test.ts
  - tests/web/store.test.ts
  - tests/web/transcript-paging.test.tsx
---

# Conversation experience

## Goal

Make the browser a complete, calm, and truthful presentation of an active Pi conversation.

## Checks

- User and assistant messages appear in source order without duplicate or missing settled content after reconnecting. A keyed message updates only its own key; if an earlier turn lacks its end event, the next keyed assistant turn appends rather than overwriting it.
- Markdown math accepts `$…$`, `$$…$$`, `\\(…\\)`, and `\\[…\\]` through token-aware parsing. Inline/fenced code and escapes stay code/text, valid same-line and multiline displays remain math, and any unclosed opener remains exact readable source while a response streams.
- Copying a selection containing KaTeX writes ordinary selected HTML plus a plain-text source projection. Formula bodies use canonical `$…$` inline or `$$…$$` display delimiters, including partial selections whose original formula wrapper determines display identity; surrounding selected text and multiple formulas are preserved.
- View-local search performs case-insensitive literal matching over settled conversation text and can scope results to all searchable turns, user input only, or model output only. It wraps previous/next navigation and jumps by transcript row through virtualization. The streaming tail and hidden thinking/tool payloads are excluded. An active selected match locks out geometric latest-follow across prepends and live appends until search is cleared or the user explicitly jumps to latest.
- User turns appear as compact bubbles while assistant answers use an open, left-aligned document flow suitable for long Markdown, mathematical notation, code, and structured activity.
- Assistant text streams smoothly without visually rebuilding the entire transcript for every fragment.
- Thinking appears separately from answer text, follows the user’s independent hidden, collapsed, or expanded preference, and drops terminal-only control formatting at the display boundary without rewriting Pi history.
- Each tool call is correlated with its live status, partial output, final result, and failure state.
- Tool activity uses compact cards by default while retaining an explicit path to complete arguments and output when safe to show.
- A tool result recognized as a unified diff renders as typed, tinted lines (added, removed, context, hunk, file markers) instead of a raw dump, and is never truncated; recognition is strict enough that prose with leading `-`/`+` characters is never recolored.
- Structured file paths and explicit local file references in conversation content remain distinguishable from external web links and can open the owning session’s resource preview.
- The contextual Branches mode shows the bounded Pi entry tree, active path, and effective leaf. Branch switching, edit-from-here, and fork are explicit confirmed actions; edit and fork copy the original user text into the destination composer without auto-submitting it, and unsupported root-user edit is visibly unavailable.
- Unknown tools and noninteractive extension display messages receive a generic, attributable, inspectable fallback instead of disappearing. Payloads remain subject to host redaction and transport bounds; unsupported future response-bearing methods enter the same cancellable dialog model rather than being dropped.
- Concurrent extension dialogs are retained in arrival order by Pi request id while the oldest is modal. Responses are idempotent in the browser, revalidated inside the host mutation gate, and remove only their owning request. Positive Pi timeouts are bounded and mirrored with host expiry timers; expiry, settle, abort, worker replacement/exit, and close remove stale requests, and snapshots restore only live requests.
- The user can abort active work, send steering input during work, and queue follow-up input for after completion. Exact ordered steering and follow-up arrays remain separate in live events and reconnect snapshots, render as labelled pending rows outside persisted messages, and clear on settle or worker replacement without inventing cross-queue chronology or cancellation controls.
- Running, retrying, compacting, queued, aborted, failed, and settled states remain distinguishable.
- When earlier history exists, approaching the transcript top automatically requests the next cursor-bound page. Coalesce an in-flight request, prepend only when the session generation, revision, view, and effective leaf still match, then restore the same visible message at the same viewport offset through virtualization. Same-view snapshots preserve pages already loaded behind a changed older cursor, while a rewrite or view change replaces them. Ordinary failure pauses automatic loading and exposes an explicit retry; a stale cursor still resyncs from the authoritative snapshot. The host's existing page and cursor bounds remain unchanged.
- Refreshing the browser reconstructs settled conversation state from Pi and then resumes live updates.

## Non-goals

- Web cards do not have to reproduce ANSI rendering or terminal-only custom components.
- Raw provider payloads and credentials are not part of the browser conversation model.
