---
scope:
  - server/runtime*.ts
  - shared/contracts.ts
  - src/{api,events,rich-text*}.ts
  - src/controllers/composer-controller.ts
  - src/components/{RichText,ProgressiveRichText}.tsx
  - vite.config.ts
  - tests/server/{runtime*,pi-rpc*}.test.ts
  - tests/web/{api,app,composer-controller,events,rich-text*}.test.{ts,tsx}
  - tests/browser/{tool-presentations,filesystem-files}.spec.ts
  - scripts/benchmark-rich-text.mjs
  - tests/fixtures/rich-text-benchmark.tsx
---

# Core review repairs

## Outcome

- Extension dialogs retain their session/worker ownership across model settlement. The model-event
  controller no longer controls their cleanup. Contract: [[pi-integration]].
- Attachment uploads use bounded header/body observation, support cancellation, and reclaim observed
  late handles while preserving the originating session. Contracts: [[composer]], [[session-transport]].
- Large Markdown parses in a shared worker while new text remains readable. Whole-document semantics,
  sanitization, and memoized code/math leaves are preserved. Contract: [[rich-rendering]].

Pi codemode child-call presentation and MCP management remain deferred in [[spec_abstract]].

## Evidence

- Real Pi 0.99.1: a dialog answered after model settlement completed the waiting extension command.
  Runtime/RPC regressions passed; upload tests cover stalled headers/body, cancellation, late cleanup,
  and session ownership.
- Frontend: 1,144 tests across 95 files passed. Eleven production-build Chromium flows covered rapid
  large-response updates alongside composer typing, document images/headings, previews, tool streaming,
  and narrow-screen geometry.
- Three-round component benchmark reduced the median largest frame gap for mixed 64k/128k/256k
  updates from 50/99/209 ms to 18/18/27 ms. Method, formatting latency, and semantic checks:
  [[rich-rendering-reuse]].
- Both TypeScript projects, lint, unused-code checks, and the production web build passed.

The Host was not restarted during this repair; backend changes require a restart to take effect.
