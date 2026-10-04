---
scope:
  - src/components/{ExtensionUiDialog,ExtensionDisplays,CustomMessage,AppTopbar}.tsx
  - src/App.tsx
  - src/use-modal-focus.ts
  - src/styles/{settings-overlays,composer,topbar,responsive,transcript}.css
  - tests/{web,server,browser,fixtures}/**
  - docs/extensions.md
  - docs/examples/native-ui.ts
  - package.json
  - tsconfig.server.json
---

# Shared extension interaction

## Outcome and boundary

Pi's standard UI primitives have shared browser presentation: keyboard/pointer/touch dialogs,
retained deadlines, topbar status disclosure at every width, text widgets and readable custom messages.
Contracts: [[pi-integration]], [[workspace-layout]] and [[conversation]]. Pi and extensions retain
permission, question, task and execution policy; these controls present it.

The [portable example](../../docs/examples/native-ui.ts) demonstrates select/confirm/input/editor,
timeout, status/widget update and clear, and a recorded custom message. It ships in the package and
is included in TypeScript checks. The [adaptation guide](../../docs/extensions.md) describes the
supported RPC primitives and terminal alternatives.

**Unresolved:** Pi 1.0 resolves extension-owned AbortSignal cancellation without publishing a
dialog-dismissal event. Model idleness, generic command completion or an invented timeout cannot
identify that cancellation. Native timeout and Host Stop cleanup remain supported. Richer custom UI,
draft reads, shortcuts/completion, Codemode and MCP adaptations are tracked in
[[follow-pi-native-capability-review-2026-10-02]].

## Interaction rationale

Sequential questions can arrive before the previous HTTP response finishes. Modal focus therefore
skips disabled controls and moves fallback focus into newly enabled controls while retaining an
explicit initial confirmation target. It must not reclaim focus from a user-selected child or a newer
modal. Response ordering, request ownership and opener restoration remain unchanged.

Status/widget keys are update identities, not headings. Widgets foreground supplied text and Copy;
custom messages keep readable/configured titles and lazy raw inspection. Widgets use groups inside
named placement regions rather than repeated landmarks.

## Recorded verification

- **Installed Pi 1.0:** `pi-extension-ui.integration.test.ts` runs `/ui-demo` through
  `RuntimeController.prompt` after inventory readiness. It completes all four dialogs, checks status
  and both widget placements, persists a custom message and clears displays. It also covers native
  timeout/Host expiry, answered/expired ID refusal, stable worker PID and no model turn. Native roots
  and credentials are isolated.
- **Ownership/focus:** `overlay-and-palette`, `modal-focus`, `custom-message` and
  `transcript-inspection` regressions cover delayed question handoff, confirmation focus, user-chosen
  controls, deadline remount, widget copy/clear and configured-message presentation.
- **Chromium:** `tests/browser/extension-ui.spec.ts` passed at 1280×900 light and 390×844 dark/touch.
  It covers arrows/Enter, pointer/touch selection, Escape, input versus multiline submission,
  deadlines across reload, opener/draft preservation, 44px targets, status overflow reading, full
  widget Copy and clearing. Targeted Axe checks found no dialog/status/widget violations.
- **Author surface:** four public presentation examples validated against the schema; keyboard
  resource-list activation and narrow reading passed. The guides distinguish resource lists from
  task displays and document the internal GUI bridge. TypeScript, targeted lint and the web build
  passed for these checks.

Images under `output/playwright/` include `extension-selection-desktop.png`,
`extension-content-desktop.png`, `extension-content-narrow.png` and
`extension-status-expanded-narrow.png`. They use synthetic browser data; native protocol evidence
comes from the runnable extension test. The missing AbortSignal event was confirmed by a separate
isolated native probe and is not repaired by these interaction checks.
