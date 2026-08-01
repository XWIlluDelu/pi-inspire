---
purpose: One browser composer submits ordinary prompts, project context, images, files, steering messages, and follow-ups without exposing local privileges.
covers:
  - server/app.ts
  - server/attachments.ts
  - server/project-files.ts
  - server/runtime.ts
  - src/api.ts
  - src/store.ts
  - src/components/Composer.tsx
  - tests/server/app.test.ts
  - tests/web/composer-sessions.test.tsx
  - tests/web/composer.test.tsx
---

# Conversation composer

## Goal

Cover the input modes needed to replace the primary terminal conversation loop.

## Checks

- The composer accepts multiline text; each session keeps its own unsent draft, staged attachments, and project-file references, restored when the user switches back (in-memory — staged work does not survive a reload). Empty session partitions are discarded, while non-empty partitions remain until their user-owned work is sent or removed.
- Project files can be found through the session-addressed project index, either in the explicit picker or from the textarea’s active caret token. `@` completion never treats other mentions as file authority: choosing a returned canonical path removes only the active token, preserves the surrounding draft and caret, and stages one deduplicated removable file-reference chip.
- Leading `/` completion is offered only while the caret remains inside the command token Pi would parse. Pi’s runtime commands retain source attribution and first wire ownership so extension-before-prompt/skill collision behavior matches Pi dispatch; inspire then explicitly overrides `/compact` from the same descriptor/parser authority as its execution boundary. Choosing a result inserts the exact command plus a trailing space without executing it.
- Both completion lists expose loading, empty, and failure states, support pointer and arrow/Enter/Tab/Escape interaction with combobox/listbox semantics, suppress stale session results, and defer to IME composition, multiline input, steering, and follow-up behavior. The multiline textbox keeps DOM focus and owns `aria-controls`, `aria-activedescendant`, and autocomplete state inside its named ARIA 1.1 combobox composite.
- Images can be pasted, dropped, or selected and previewed before submission.
- Ordinary files can be selected or dropped, with their name, type, size, and submission meaning visible before sending.
- Input submitted while Pi is active is explicitly sent as steering input or queued as a follow-up.
- A typed `/compact [instructions]` is routed at the host prompt boundary to Pi's compact control, because the runtime does not parse built-in commands out of prompt text.
- The composer displays the selected model, thinking level, and context occupancy as quiet controls that do not crowd the writing surface; project identity lives in the topbar per [[workbench]]. The model picker groups Pi-provided models by canonical provider identity, searches provider/id/display fields locally, labels active/recent/capability state, restores trigger focus after Enter, click, or Escape without waiting for asynchronous model ownership, retains that focus through a later mutation-error rerender, and uses only successful model changes to maintain a bounded global MRU ordering within each provider. Unavailable MRU identities stay harmless preference history and are omitted from the current projection.
- The start surface accepts the first message together with an optional project directory, so a new session can begin in a chosen workspace.
- Submission errors preserve the draft and attachments. Project-file chips are frozen while delivery is in flight, remain partitioned with other composer artifacts by session, and clear only from the owning partition after the host accepts the exact delivery that included them.
- Attachment data crosses the trusted host only through bounded, validated operations and is not silently uploaded elsewhere by inspire.
- Uploaded attachments have a bounded host-side lifetime: withdrawing a staged attachment deletes its host cache copy, image bytes are reclaimed once a delivered prompt has consumed them, and ordinary files persist for the host’s lifetime because their host paths are referenced by the conversation text.

## Non-goals

- The first release does not need a complete project file manager.
- File attachment does not imply arbitrary automatic ingestion of every file format.
