---
scope:
  - server/runtime.ts
  - server/runtime-slot.ts
  - server/runtime-events.ts
  - server/session-projection.ts
  - src/components/Composer.tsx
  - src/styles/composer.css
  - docs/pi-commands.md
  - tests/server/{runtime-compaction,runtime-pending}.test.ts
  - tests/server/fixtures/{runtime,preview-projection}.ts
  - tests/server/pi-operation-lifecycle.integration.test.ts
  - tests/fixtures/pi-operation-lifecycle-extension.ts
  - tests/web/composer.test.tsx
  - docdoki/specs/{pi-integration,composer}.md
  - docdoki/notes/operation-lifecycle-ownership.md
---

# Native compaction cancellation and context detail

## Objective

Use Pi's native cancellation for standalone manual compaction through existing Stop/Escape, preserving
neutral cancellation and Pending recovery without routinely replacing the worker. Add the approved
read-only context hint and retain unknown post-compaction occupancy. Contracts are [[pi-integration]]
and [[composer]]; [[operation-lifecycle-ownership]] retains the settlement rationale. No new compaction control, automatic-compaction
status, summary-input form, or token-budget editor is included.

## Current state

- Standalone Stop recovers Pending and uses native cancellation; cooperative cancellation retains
  the worker and extension state. Unresponsive explicit cancellation uses confirmed retirement.
  [[pi-integration]] owns the event/response/retirement contract; the lifecycle note explains why
  newly committed checkpoints, not old durable-branch checkpoints, win a Stop race.
- The existing context ring/percentage reveals model name and Pi used tokens/capacity on hover, focus,
  or tap. It is a read-only hint with no focus transfer or reserved layout. Unknown usage keeps `—`
  and known capacity, with “Updates after the next reply”; outside tap dismisses the hint. Escape
  dismisses an open hint, including hover, without also stopping work; IME keeps its Escape ownership.
- Native lifecycle, Runtime/Composer and populated desktop/touch checks establish these behaviors,
  including known/unknown usage and narrow reading.

## Verification

- **Actual installed Pi 1.0, Node 26.10.0, Linux:** four focused cases in
  `tests/server/pi-operation-lifecycle.integration.test.ts`, explicitly selected with
  `INSPIRE_TEST_PI_COMMAND`, passed through the authenticated Inspire Host/browser API. Current-branch
  Stop recovered Pending without resuming input; current/earlier branch cancellation retained the PID,
  session and extension counter and allowed another compact; an existing earlier-branch checkpoint was
  not mistaken for new completion. An unresponsive hook retired only after native abort failed to
  settle. A newly committed checkpoint on the earlier effective branch, followed by a native custom
  entry and suspended hook, remained completed after Stop retired the worker.
- Native fixture HOME/config/session/auth/model/temp roots were isolated. Compaction used the shared
  offline extension and made no provider/model requests. These are installed-native claims, not
  claims about checkout-pinned Pi 0.87 integration defaults.
- Three focused Runtime regressions passed: arbitrary native hook diagnostics produce one neutral
  outcome without replacing Pi; pending retirement cannot settle cancellation early; rejected retirement
  retains the writer fence and rejects new input instead of creating another worker.
- Three focused Composer cases passed: unchanged Steer/Stop availability during compaction; hover,
  keyboard focus, tap/outside dismissal and consumed Escape versus IME Escape; unknown-to-known count
  transition without replacing known capacity with zero.
- **Fresh browser build, Chromium desktop and touch emulation:** hover and actual Tab focus showed
  the native model name/count/capacity without moving focus or composer layout. Injected unknown
  usage retained `— / 131,072 tokens` and the next-reply hint. Escape dismissed the hovered hint
  without issuing Stop; the following ordinary Escape issued exactly one Stop request. Real touch
  tap/outside-tap dismissal and a 44px hit target passed at 375px. A long native display name also
  wrapped inside a 320px viewport. The isolated mock Host and
  transport-decorated unknown/busy state establish browser behavior, not additional native-Pi claims.
  No browser page errors were observed. Screenshots: `output/playwright/block8-context-{hover,focus,unknown,touch,narrow}.png`.
- Composite TypeScript and the bundled DocDoki privacy/reference-boundary check passed.
