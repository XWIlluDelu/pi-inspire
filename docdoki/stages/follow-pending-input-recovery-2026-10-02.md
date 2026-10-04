---
scope:
  - docdoki/specs/{composer,pi-integration}.md
  - docs/pi-commands.md
  - server/{runtime*,pending-image-evidence,attachments,app,mock}.ts
  - server/extensions/inspire-branch-bridge.ts
  - shared/{contracts,branch-bridge-protocol}.ts
  - src/{api,app-state,store}.ts
  - src/controllers/composer-controller.ts
  - src/components/{Composer,Transcript,transcript-rows}.tsx
  - tests/{server,web,shared}/**
  - tests/fixtures/pi-operation-lifecycle-extension.ts
  - tests/browser/{workbench,pending-input}.spec.ts
  - vitest.config.ts
---

# Pi-native pending-input recovery

## Outcome

Return and Stop recover native queued text and original submitted images into the originating
session's latest draft. Complete Copy leaves the queue unchanged; confirmed Clear discards it.
[[composer]] owns ordering, merging, send limits, focus and complete-text coordinates.
[[pi-integration]] owns clear/abort ordering, worker retention and bounded native evidence;
[[follow-compaction-cancellation-2026-10-02]] covers cooperative compaction cancellation.

## Ownership boundary

Pi dequeues captions, not image bytes or item identities. Recovery transfers retained original Inspire
submissions, including history copies and repeats; it does not reconstruct extension-replaced bytes
or recover an in-memory queue after restart. The native bridge corroborates ambiguous ownership from
post-cursor persisted identities without transporting image bodies. Raw consumption events retain
precedence. A delayed `message_start` hook can still leave same-caption alternatives unresolved;
that case warns rather than returning another row's image. Known text-only recovery stays quiet.

Settlement preserves in-flight recovery and consumed-row markers until native captions disappear.
Still-Host-held artifacts are restaged, and `PROMPT_RECOVERED` prevents duplicate failed-delivery
restoration. These are ownership boundaries, not a second queue or scheduler.

## Evidence

- The installed-Pi large-history regression uses two retained 14 MiB images without a provider task.
  The former `get_messages` response was 39,147,195 bytes, exceeding the unchanged 34,603,008-byte
  frame cap and retiring the worker. The bridge baseline is 401 bytes; two identity records plus
  cursor total 1,871 bytes across separate frames. The worker stays available. The regression checks
  duplicate-identity multiplicity, delta reads and invalid-cursor refusal in
  `tests/server/runtime-pending-image-evidence.integration.test.ts`.
- The image-only stale-caption repair was verified against installed Pi 1.0 with a gated loopback
  provider: both Steer and Queue remove consumed images from Pending while preserving later images
  and complete captions. Native empty captions can survive settlement and the next run; filtered
  previews, full-text coordinates and recovery continue to exclude consumed rows. The related
  settle-before-clear-receipt race now retains the pending image, covered by a Runtime regression.
- Known correlated images carry `imageCount`; the restored panel displays Image or N images without
  classifying unknown empty rows. Component and fresh Chromium checks cover these visible labels.
- `runtime-pending`, `runtime-pending-images`, attachment/retention, API, controller and store regressions passed:
  duplicate/same-caption ownership, both modes, image-only input, response races, history copies,
  discard/retirement and unwritten preparations. Held-copy cases finish Stop before IO resumes and
  establish zero old prompt writes, reusable originals and admissible new input.
- `tests/server/pi-operation-lifecycle.integration.test.ts`, explicitly selecting installed
  **Pi 1.0.0** with `INSPIRE_TEST_PI_COMMAND`, passed real RPC → Host HTTP → browser-API recovery,
  discard, Stop, consumption and delayed-event cases. Invisible same-caption replacement restores
  the original PNG where owned and never returns an already-consumed original. The local synthetic
  provider also establishes Stop without a second model turn. Earlier text-only cases passed on
  both Pi 0.87.0 and 1.0.0.
- Fresh-build Chromium `pending-input.spec.ts` flows passed for Return/resend, image-only Escape,
  complete individual/all copying, Clear confirmation, Stop and modal/global Escape. Composer
  draft/expansion coexistence remains in the workbench checks. Real
  staged handles and loaded thumbnail dimensions establish browser artifact behavior; native queue
  semantics are established above. Screenshots: `output/playwright/pending-images-{return,escape}.png`.
- `transcript-inspection` checks explicit Return focus and newer focus/shared-modal ownership;
  `pending-input.spec.ts` verifies focused Return then actual typing, while keeping Escape's distinct
  image/queue ownership checks. Copy remains an explicit full-text fetch, not preview copying.
  Return's tooltip describes the operation; cooperative cancellation says Cancelling compaction.
- Typecheck, scoped lint and diff checks passed at acceptance. Tests use isolated roots/processes.
