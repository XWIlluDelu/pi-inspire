---
scope:
  - src/store.ts
  - src/controllers/branch-controller.ts
  - tests/web/{store-async-ownership,branch-store}.test.ts
---

# Runtime and quality review

## Objective

Review key correctness, responsiveness, and implementation-quality boundaries;
repair demonstrated defects and report product-design changes before making them.

## Outcome

The review is complete. Five demonstrated asynchronous-state defects were repaired
in the existing store and History controller, with 13 regression cases. Typecheck,
production Web build, all 160 Vitest files (1,664 passed; 2 skipped), and the 44-case
isolated Chromium gate passed. Scope, reproduction details, and verification
limits live in [[async-ownership-review]].

At review closure, the proposed change to Fork's global selected-source constraint
was reported but deferred for approval. The user subsequently approved it;
[[async-ownership-review]] records the implemented follow-up. No speculative
performance optimization, dead-code cleanup, or reconnect fallback was retained.
