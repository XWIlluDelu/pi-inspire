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
  - tests/web/composer.test.tsx
---

# Conversation composer

## Goal

Cover the input modes needed to replace the primary terminal conversation loop.

## Checks

- The composer accepts multiline text and preserves a draft while the user changes sessions only when that behavior is unambiguous.
- Project files can be found and referenced through an explicit picker or completion flow.
- Images can be pasted, dropped, or selected and previewed before submission.
- Ordinary files can be selected or dropped, with their name, type, size, and submission meaning visible before sending.
- Input submitted while Pi is active is explicitly sent as steering input or queued as a follow-up.
- The composer displays the selected model, thinking level, current project, and destination session without crowding the writing surface.
- Submission errors preserve the draft and attachments.
- Attachment data crosses the trusted host only through bounded, validated operations and is not silently uploaded elsewhere by inspire.

## Non-goals

- The first release does not need a complete project file manager.
- File attachment does not imply arbitrary automatic ingestion of every file format.
