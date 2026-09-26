---
scope:
  - docdoki/specs/{composer,conversation,pi-integration}.md
  - shared/{commands,contracts}.ts
  - server/{app,pi-rpc,runtime,runtime-events,session-projection}.ts
  - src/{api,app-state,store}.ts
  - src/controllers/{composer,runtime-event}-controller.ts
  - src/components/{AppTopbar,CommandPalette,Composer,ComposerInput,Transcript,Welcome}.tsx
  - src/components/{transcript-cards,transcript-row-projection,transcript-rows}.tsx
  - src/styles/*.css
  - tests/server/**
  - tests/web/**
  - tests/browser/workbench.spec.ts
---

# Native command surface

## Objective

Adapt Pi's native commands to the browser while keeping command dispatch, operation feedback,
and ordinary prompt delivery distinct. Contracts: [[composer]], [[conversation]], [[pi-integration]].

## Implemented

- `shared/commands.ts` reserves built-in names before extension/prompt/skill resources, matching
  Pi's interactive client. Browser controls reuse existing surfaces; compact/export/reload use
  typed Host operations; terminal-only and unknown commands stay out of model prompts.
- Manual compaction has immediate running feedback and worker-scoped cancellation. Its durable
  summary is a chronological transcript card. Retry reasons wrap, and activity headers omit clocks.
- Host-held Steer/Queue and Clear remain available through compaction and long command receipts.
  Each input owns its draft, attachments, and retry identity; export and local controls remain
  available during active work where their operation permits it.
- Simple command success uses a short notice; failure retains its attributable receipt. A successful
  compact receipt currently remains until dismissed or later agent work/compaction starts.

Mechanisms and regression coverage are in [[native-command-compatibility]]. The 2026-09-25 delivery
review passed 181 focused tests, a real-Pi preflight-compaction fixture, TypeScript, and formatting.
Earlier card/layout checks passed 64 focused tests and six Chromium cases across light/dark and
1280/390/320px widths.

## Pending presentation review

The proposed immediate retirement of a successful compact receipt is **not decided or implemented**.
The user requested a transcript inventory before broader visual unification. Keep the current
lifecycle while evaluating which results belong in history and which remain transient feedback.

## Next actions

- Inventory transcript rows and transient command results, including their data authority and lifecycle.
- Use that inventory to decide the compact-success proposal and any broader presentation change.
