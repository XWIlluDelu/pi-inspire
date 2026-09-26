---
scope:
  - src/components/TerminalView.tsx
  - src/components/TerminalTextDialog.tsx
  - src/terminal-input.ts
  - src/terminal-output.ts
  - src/use-copied.ts
  - src/styles/terminal.css
  - tests/web/terminal-*.test.*
  - tests/browser/workbench.spec.ts
---

# Terminal touch input and text selection

## Outcome

Completed the delegated mobile terminal refinement under [[terminal]]. Copy all
and Select text are direct menu actions; the stable native text view supports
partial selection, Select all, Copy, and quoting into the composer. Height-only
resizes retain command-output ranges. Touch keys preserve focus, the keyboard
button explicitly requests input, and Ctrl+C works without a software keyboard.

Shared text extraction and key encoding replace duplicated paths.
[[terminal-controls-redesign]] records the implementation rationale and the
136 unit checks, four real-PTY browser scenarios, responsive/accessibility
checks, and build/static validation.
