---
purpose: Track the remaining follow-up work from the 2026-07-22 pre-commit review of concurrent sessions, navigation pinning, and session-bound previews; findings leave this list as they are verified fixed.
---

# Follow-up code-review findings

The correctness findings from the original review closed in the 2026-07-25
external-review round (archived stage `challenge-external-review-2026-07-25`),
each with a regression test: field-scoped serialized preference patches,
visible-session revalidation for resource handles (including after awaited
message fetches), provisional-id extension-dialog rebinding, active-group
collapse honoring saved state, `bashExecution.fullOutputPath` discovery, and
keyboard access to file previews through the card body's real file button (the
tool-summary span stays a pointer-only shortcut layered on that path). The
same round bounded the attachment lifecycle (withdrawn and image-consumed
uploads are reclaimed host-side).

## Open items

Efficiency work stays deferred until a measurement justifies it; none of it
blocks correctness.

- [ ] Bound image/PDF/audio/video preview size and cancel obsolete
  resolve/content requests on another selection, pane close, or session
  switch — stale responses are already ignored, but the transfers themselves
  are neither aborted nor size-capped (`src/api.ts`, `src/store.ts`).
- [ ] Avoid rescanning the full transcript on every streaming delta; cache
  extraction per stable message or refresh the file list only at meaningful
  message/tool boundaries (`src/resources.ts`, `shared/resource-references.ts`).
- [ ] Cache the authoritative resource-message projection per session revision
  so one preview does not repeatedly request and scan all messages; reuse it
  for embedded-image content delivery (`server/runtime.ts`, `server/resources.ts`).
- [ ] Narrow React store subscriptions and remove per-row whole-store
  subscriptions in navigation and file rows so token deltas do not rerender
  unrelated chrome (`src/store.ts`, `src/components/Nav.tsx`, `src/components/ResourcesPane.tsx`).
- [ ] Coalesce settlement-driven session-catalog refreshes; explicit user
  refresh remains immediate (`src/store.ts`, `server/session-catalog.ts`).
- [ ] Measure host and child-process memory as many sessions are opened, then
  define an eviction policy only if the measurement justifies one; never evict
  busy sessions or sessions awaiting extension input (`server/runtime.ts`).
- [ ] Consolidate duplicated tool-path normalization, pin-list updates, byte
  formatting, and visibility preference enumeration when implementing the
  related fixes.

## Verification expected

When picking these up: regression coverage for cancellation and size limits,
and measured (not assumed) rerender/refresh/memory behavior before and after.
Re-run `npm run check` and `npm run build` after the final edits.
