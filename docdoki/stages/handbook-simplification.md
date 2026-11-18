---
scope:
  - src/**
  - server/**
  - shared/**
  - extensions/**
  - scripts/**
  - tests/**
---

# Internal simplification

## Current state

The simplification retained the workbench's established menus, layouts, and keyboard behavior.
The current [design contracts](../spec_abstract.md) describe those interactions. The original
handbook and its deletion estimates are historical. Its proposed interaction changes no longer
guide implementation.

At `29870a41`, the tracked TypeScript, JavaScript and CSS inventory was 203,143 lines.
Against the original inventory at `3e123767`, this removed 48,798 lines, including
16,695 application and style lines and 32,103 test lines. The inventory excludes generated
font styles and is a record of that snapshot.

- Conversation history scrolls continuously. Prompt Map navigates within the conversation, and
  the right-side History tab inspects saved routes and branches. Composer keeps inline
  arrow-key recall and cursor-relative completion.
- Opening a conversation warms Pi in the background so the extension controls can appear
  before the first send. Native worker admission still checks the current writer.
- Prompt, Pending, terminal and restart recovery observe the original operation receipt.
  Uncertain prompt delivery does not block drafting or sending another message.
- File and terminal actions float over the content. Both use the unified tab strip while the
  existing terminal attachments and native process lifetimes remain independently owned.
- Frontend builds keep recent hashed assets available to open tabs. Native Pi session files
  and stored attachments remain readable.
- Ubuntu CI runs the core checks and key Chromium workflows. Main pushes also run the installed
  package check. See [CI verification](../notes/platform-compatibility.md#ci-verification-scope).
- HTTP test routes supply current receipts and preference publications explicitly. The transport
  fixture passes malformed responses through unchanged. Composer and local notification tests
  exercise their own controllers directly where they do not need full store wiring.

## Remaining work

- Consolidate runtime queue and reconciliation code where the native scheduling rules match.
  Preserve the different completion evidence for input delivery, Pending handoff, terminal
  epochs and launcher exit.
- Share native command dispatch, configuration fields and tool or extension rendering where
  their current contracts match. Keep the established interaction for each surface.
- Replace duplicate synthetic tests with coverage at the owning layer. Retain real Pi, PTY,
  filesystem and browser fault cases.
