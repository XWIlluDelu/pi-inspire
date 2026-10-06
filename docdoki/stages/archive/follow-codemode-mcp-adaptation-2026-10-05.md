---
scope:
  - src/components/{ChildCalls,transcript-cards}.tsx
  - src/tool-presentations/pi-native.ts
  - src/{events,store}.ts
  - src/styles/activity-cards.css
  - server/{runtime*,session-projection}.ts
  - shared/{contracts,tool-activity}.ts
  - tests/{server,web,browser}/**
  - docdoki/specs/{tool-presentations,mcp}.md
  - docs/tool-presentations.md
---

# Codemode, nested calls and native MCP adaptation

## Outcome

Codemode and nested-call presentation is implemented on released Pi 1.0.0. The user approved the compact design
following independent Gemini and Astra review. Gemini also reviewed the actual desktop/mobile screens.

- Codemode uses its native `details.calls`, including model calls. Generic execution uses live parented
  events and persisted top-level `nestedCalls`. Each parent has one displayed call list.
- Shared bounded rows show status, identity and a useful parameter summary. Available parameters,
  errors and duration open on demand; previews remain labelled previews.
- CodeMode keeps Calls → Output → Script, with a light call list and one native-style inset output
  area. Other nested tools lead with results after settlement unless their calls are being read.
  Calls/Script inspection holds the card and Adaptive activity group, retaining focus and inner
  scroll position. Keyed blocks keep visual and keyboard order aligned.
- Calls summarize complete fields from truncated parameter previews without showing broken JSON or
  guessing missing values. Header copy retains the complete tool block, consistent with other cards.
- Reconnect restores Host-held activity. Parent outcome remains independent of child failures.
  Existing mapping precedence, raw inspection, copy and authorized result readers remain available.
- No cost UI, completion percentage, per-call stop/retry or generic compatibility layer was added.

Contracts: [[tool-presentations]], [[activity-presentation]] and [[pi-integration]].

## Verification

- The native offline integration test executes actual freeform Codemode input, confirms normalized
  `arguments.code`, observes tool/model progress and generic recursive calls, and reopens JSONL history.
  It covers failed children with a successful parent and distinct native record sources without
  contacting a remote model.
- Focused projection, event, store, presentation and resource checks pass. The final Adaptive/inspection
  web group passed 105 tests; session projection passed 37.
- Desktop/mobile browser flows pass across native settlement and Adaptive close delays. They cover
  script/call disclosure ownership, keyboard/touch operation, focus, list scrolling, fixed CodeMode
  section order, accessibility and horizontal overflow. Existing output/resource flows also pass.
  Focused summary and card tests cover partial-parameter summaries, readable output and whole-block copy.
- Formatting, lint, type and unused-code checks passed in the implementation tree. Mainline type
  checking and the web build pass.
- The mainline default suite passed 2,319 tests, with two failures in existing verification paths.
  The Files test now waits for lazy content rather than only its shell. The Git fixture assumes its
  temporary root has no `.git` ancestor; this machine's default root has such a marker. Both suites
  passed all 38 tests after the wait correction and use of a repository-free temporary root.

Evidence images: `output/playwright/child-calls/{desktop,mobile}-{running,settled-reading,reopened}.png`.
Native regression: `tests/server/pi-child-calls.integration.test.ts`.

## Deferred MCP management

Configured MCP calls continue through Pi and benefit from the applicable call/result presentation.
Complete graphical configuration/connection management remains deferred in
[[follow-pi-native-capability-review-2026-10-02]]; [[mcp]] retains the conditional compact design.

[[mcp]] distinguishes supported file configuration from missing current-worker management interfaces.
An isolated native probe confirmed that separate CLI connections do not report the addressed worker,
configuration edits do not update loaded state, and unsupported management subcommands can return a
handled command receipt without applying the action.

The user clarified that missing interfaces do not authorize changes to Pi or a patched runtime.
No Pi patch or dependent MCP implementation is retained. The installed Pi and running Host were not
modified or restarted by this task; backend changes take effect after the Host's next restart.
