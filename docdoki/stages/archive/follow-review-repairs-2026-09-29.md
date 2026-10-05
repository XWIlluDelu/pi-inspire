---
scope:
  - server/{session-catalog,session-metadata,pi-session-directory,project-directories,preferences}.ts
  - server/{runtime,runtime-reads,runtime-startup-attestor,session-projection}.ts
  - src/api.ts
  - src/controllers/{connection,session-selection}-controller.ts
  - src/components/{RichText,RichTextMath}.tsx
  - docs/extensions.md
---

# Review repairs

## Outcome

Completed against baseline `36fb3ac`:

- Pi environment/project settings and relative paths now drive session discovery. Known project
  roots survive Host reconstruction and Unpin/Unhide independently of navigation curation.
- HTTP observers have timeout/cancellation ownership; startup windows allow Pi's read budget.
  Long commands remain completion-driven, and uncertain mutations are not automatically replayed.
- Unlabelled/indented code retains block structure and copy. Rich rendering reuses unchanged
  math/code leaves while parsing the complete Markdown document.
- Ordinary reads reuse unchanged verified session projections; changed files and writer/startup
  boundaries retain validation.
- Extension guidance now covers startup dialogs and independent-worker lifecycle differences.

Contracts: [[session-continuity]], [[session-transport]], [[session-persistence]]. Mechanisms and
measurements: [[rich-rendering-reuse]] and [[projection-reconciliation-ownership]].

## Verification

Frontend tests passed. The integrated server/shared and Welcome run passed 809 tests with two skips
across 85 files, including real-Pi session creation/continuation and Host reconstruction using an
isolated loopback model fixture. Five Chromium workflows passed against the production-built mock
Host. TypeScript, format, lint, Knip, and build checks passed.
