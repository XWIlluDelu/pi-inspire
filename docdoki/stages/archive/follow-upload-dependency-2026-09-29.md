---
scope:
  - package.json
  - package-lock.json
  - server/attachments.ts
  - tests/server/attachments.test.ts
  - tests/server/app.test.ts
---

# Multipart dependency update

## Outcome

Multer is updated from 2.2.0 to 2.4.0, clearing the production dependency findings under
[[host-lifecycle]]. Attachment handling needed no adapter change. [[dependency-boundaries]] records
the version and advisory.

## Verification

On 2026-09-30, 67 tests in `attachments.test.ts` and `app.test.ts` passed, covering upload limits,
cleanup, and application routes. `npm audit --omit=dev` reported zero vulnerabilities.
