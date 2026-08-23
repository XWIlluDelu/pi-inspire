---
scope:
  - shared/tool-presentation-config.ts
  - src/tool-presentations/
  - src/components/transcript-cards.tsx
  - tests/server/app.test.ts
  - tests/server/tool-presentation-config.test.ts
  - tests/web/tool-presentations.test.ts
  - tests/web/thinking-presentations.test.tsx
  - docdoki/spec_abstract.md
  - docdoki/specs/tool-presentations.md
---

# Thinking presentations

## Objective

Let a machine-local declarative rule customize a Thinking card's summary and structured expanded body while the existing Thinking shell, lifecycle, copy behavior, safety boundary, and native fallback remain authoritative.

## Outcome

- The optional top-level `thinking` declaration reuses the bounded summary and typed-block grammar with display-cleaned `thinking.text` as its sole dynamic source.
- Tool and Thinking field namespaces are validated independently; invalid configuration disables the complete user layer.
- Thinking keeps its native summary when no configured projection resolves, and keeps native rich text as the body fallback when configured blocks are runtime-incompatible.
- The Host bootstrap path, compiler, fixed card shell, structured body, terminal cleanup, and fallback behavior have focused coverage.
- The standing activity-presentation specification now owns this contract and its configuration example.
