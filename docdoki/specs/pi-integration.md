---
purpose: A trusted local host runs the user’s actual Pi environment and exposes only the typed controls and projections needed by the replaceable web interface.
covers:
  - server/**
  - shared/contracts.ts
  - src/api.ts
  - src/store.ts
  - src/components/ExtensionUiDialog.tsx
  - tests/server/**
---

# Pi integration

## Goal

Use Pi as the sole agent runtime while keeping privileged local capabilities out of the browser.

## Checks

- The local host uses the active Pi installation or a clearly reported compatible runtime rather than implementing an independent agent loop.
- The normal Pi agent directory and project working directory remain authoritative for settings, credentials, models, extensions, skills, prompts, context files, and sessions.
- The browser receives model availability and runtime state but never stored credential values.
- Local-file preview requests are authenticated and bound to the selected Pi session: every path requires an exact authoritative session reference, with relative paths resolved against that session’s project directory.
- Pi message, tool, queue, retry, compaction, session, and extension-interaction events cross a typed, validated host interface.
- The host rebinds event subscriptions and extension interaction after any Pi operation that replaces the active session runtime.
- Dialog-style extension interaction has a web-native presentation or a clear fallback.
- Terminal-only extension components do not prevent the underlying tool or command from working when a generic web presentation is possible.
- Extension failures remain attributable to their originating lifecycle and operation; the host does not silently suppress, retry, or reinterpret them through extension-specific catch-all behavior.
- Pi’s saved project-trust policy remains authoritative; the host does not load project resources through a separate bypass path.
- The host binds locally by default and does not expose unrestricted Pi control to another machine.

## Non-goals

- Complete visual compatibility with every third-party TUI component is not required.
- The browser is not a general remote shell or direct filesystem client.
