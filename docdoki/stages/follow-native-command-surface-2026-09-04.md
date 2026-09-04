---
scope:
  - docdoki/specs/composer.md
  - docdoki/specs/conversation.md
  - docdoki/specs/pi-integration.md
  - shared/commands.ts
  - shared/contracts.ts
  - server/app.ts
  - server/pi-rpc.ts
  - server/runtime.ts
  - server/runtime-events.ts
  - server/session-projection.ts
  - src/api.ts
  - src/app-state.ts
  - src/store.ts
  - src/controllers/composer-controller.ts
  - src/controllers/runtime-event-controller.ts
  - src/components/AppTopbar.tsx
  - src/components/CommandPalette.tsx
  - src/components/Composer.tsx
  - src/components/ComposerInput.tsx
  - src/components/Transcript.tsx
  - src/components/transcript-cards.tsx
  - src/components/transcript-row-projection.tsx
  - src/components/transcript-rows.tsx
  - src/components/Welcome.tsx
  - src/styles/*.css
  - tests/server/**
  - tests/web/**
  - tests/browser/workbench.spec.ts
---

# Native command surface

## Objective

Make Pi's built-in command syntax a first-class Web interaction: supported commands invoke the existing authoritative capability, unsupported terminal-only commands fail locally with useful direction, and asynchronous Host commands communicate current work, cancellation, and their result without masquerading as ordinary model prompts.

## Current state

- **Completed:** The shared registry covers Pi 0.84's interactive built-ins while preserving runtime extension/prompt/skill precedence (with `/compact` as the deliberate Host override). Browser-native commands reuse model, thinking, settings, sessions, History, naming, copy, update, and new-session surfaces. Host-native compact, HTML export, and resource reload have typed authenticated routes and named lifecycle receipts. Terminal-only commands point to the persistent project terminal, and unknown slash or bang commands cannot consume a model turn.
- **Completed:** Manual compaction acknowledges immediately in Composer, runs outside the prompt timeout, blocks misleading Steer/Queue delivery, and can be cancelled by replacing only its owning worker. Durable compaction and branch summaries render as searchable dedicated cards. Settings now expose Pi's auto-compaction, auto-retry, steering, and follow-up modes.
- **Remaining outside the built-in surface:** An extension `registerCommand()` handler still owns the prompt RPC until its preflight completes. Long handlers and unbounded extension dialogs therefore retain the existing 30-second prompt-confirmation boundary; changing that safely needs its own accepted-operation identity and cancellation design.
- **Modified files:** shared command/contracts; Host runtime/RPC/routes; Web store, Composer, command palette, Settings, transcript projection/styles; focused server/Web tests and owning specs.

## Next actions

- [x] Define a shared native-command registry, parser, argument contract, and capability mapping without claiming terminal-only behavior.
- [x] Separate Host-native command execution from ordinary prompt delivery and give it accepted/running/succeeded/failed/cancelled presentation.
- [x] Reuse existing Web surfaces for model, thinking, settings, sessions, naming, History, copy, and new-session actions; add bounded Host operations only where Pi RPC is authoritative.
- [x] Give compaction named progress, truthful uncertain-outcome state, real cancellation semantics, and a dedicated summary result.
- [x] Reject unknown and terminal-only command syntax before it can consume a model turn, with specific recovery guidance.
- [x] Preserve extension/prompt/skill dispatch and collision semantics.
- [x] Verify parser, routing, lifecycle, accessibility, responsive presentation, Pi projection behavior, and the ordinary prompt/queue path.
- [ ] Design extension-command acceptance identities and cancellation separately before extending the prompt confirmation boundary.

## Decisions

- A slash command is an explicit operation, not conversational text. Once the active command token matches a built-in name, it cannot silently fall through to the model.
- Web-native surfaces replace terminal layout while preserving Pi capability and authority; INSΠRE does not emulate terminal selectors or renderers.
- The command's compact lifecycle receipt is the signature presentation: one stable semantic surface names the command, shows its current phase, and retains only results that remain useful after settlement.
- Commands that Pi exposes only in interactive TUI receive an honest unavailable result or a mapped existing Web action; they are never advertised as executable RPC commands.

## Handoff

The built-in command surface is implemented. A future extension-command lifecycle should start from Pi's delayed `preflightResult` for `registerCommand()` handlers in RPC mode; do not merely lengthen both timeouts, because reconnect, cancellation, and retry identity would remain ambiguous.
