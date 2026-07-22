---
purpose: One defensive rendering pipeline turns Pi text into stable Markdown, mathematical notation, code, tables, and links during and after streaming.
covers:
  - src/components/RichText.tsx
  - src/components/Transcript.tsx
  - src/styles.css
  - tests/web/rich-text.test.tsx
---

# Rich rendering

## Goal

Render technical and scientific answers accurately enough that the GUI materially improves on terminal presentation.

## Checks

- Settled assistant text supports CommonMark-style Markdown, GitHub-flavored tables and task lists, fenced code, links, images, inline mathematics, and display mathematics.
- Mathematical notation renders the project name `ins$\pi$re`, ordinary inline expressions such as `$E=mc^2$`, and display expressions without exposing trusted TeX commands.
- Code blocks preserve whitespace, identify their language when available, highlight syntax, and remain copyable as source text.
- Streaming output keeps incomplete fences, links, tables, inline mathematics, and display mathematics readable until they become complete constructs.
- Final rendering after message completion is equivalent to rendering the complete source once.
- Raw HTML is disabled or sanitized under an explicit allowlist; unsafe URLs and active inline content are rejected.
- Rendering failure is contained to the affected block and leaves its source readable.
- User messages, assistant messages, thinking, and extension-provided Markdown use deliberate variants of the same rendering authority rather than unrelated parsers.

## Non-goals

- Arbitrary TeX document compilation is outside the conversation renderer.
- Active HTML artifacts are not rendered in the conversation DOM.
