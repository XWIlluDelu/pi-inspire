---
purpose: Why displayed Pi custom messages are readable context rather than tool activity, and the regression evidence for that boundary.
---

# Custom message presentation

## Decision

The user approved a neutral, information-blue message surface for displayed Pi custom messages while explicitly retaining the existing PI error surface. The current contract is in [[conversation]] and [[design-system]]. A custom message supplies extension-authored context, without the call/result lifecycle of a tool. Its optional `details` is separate from its Markdown `content`; no details entry is synthesized when that field is absent or null.

The previous tool-style card, custom activity tiles, and automatic tool-density lifecycle were removed. Tool calls and Thinking keep their existing presentation. Custom messages stay outside activity folds even when tool visibility is Hidden. The change does not alter Pi delivery or model-context conversion.

## Projection boundary

- `CustomMessage.tsx` renders Markdown and text/image blocks, preserves inspectable fallback data, and lazily mounts expanded Details.
- `transcript-row-projection.tsx` places custom messages in chronological independent rows. Host-paired entry identities retain the row across live-to-durable timestamp adoption and history prepends; host reconciliation remains unchanged.
- `server/session-projection.ts` treats displayed custom messages as visible boundaries in older-history and user-turn navigation. Merely changing the browser renderer would otherwise leave older custom content hidden in deferred activity ranges. Hidden context-only messages remain invisible.
- Settled custom content participates in All search, but not User or Model scopes. Source/type labels do not claim user or Pi authorship.

## Verification — 2026-09-07

- `vitest run tests/web tests/server/session-projection.test.ts`: 64 files, 656 tests passed, including Markdown sanitization, optional Details, image blocks, visibility, source-order separation, timestamp adoption, prepend disclosure retention, history paging, user-turn navigation, and existing PI error regressions.
- The focused checks initially ran on Node 26. Pre-commit verification also passed the complete `npm run check` on Node 22.19.0: format/lint, typecheck, unused-code check, production build, 17 portable checks, 1,165 main-suite tests, and 6 launcher tests (2 platform/condition-dependent skips across the suites). All 18 Chromium browser tests passed on Node 22, including PI error, terminal menus, activity folds, and narrow workbench regression coverage. This verifies Linux locally, not the full cross-platform CI matrix. `git diff --check` also passed.
- Real Chromium rendered the production React/CSS components using explicitly labelled fixtures: at 390px and 1100px, both light/dark and Amber/Jade palettes had no transcript horizontal overflow. The custom edge remained information-blue and the existing PI error edge remained red. Keyboard Details disclosure worked, and neither message became an activity fold with tools hidden.
- The web bundle was rebuilt. Existing Host processes were not restarted; their older-history boundary classification updates on their next restart. Browser verification was component-level, not a new full live-Pi round trip.

Local review images and the actual-component fixture are under ignored `output/playwright/custom-message-*`; they are supplementary, not required to understand the decision or run the tracked regression tests.
