---
purpose: Record concrete follow-up work found during the pre-commit review of concurrent sessions, navigation pinning, and session-bound file previews; none of these items is claimed resolved by the current commit.
---

# Follow-up code-review findings

These findings were identified after the navigation and resource-preview implementation was complete. The attempted fixes were withdrawn at the user's request so the reviewed implementation could be committed as its own checkpoint. Address them in a later, separately verified change.

## Correctness and product behavior

- [ ] Make preference mutations field-scoped or revision-aware so concurrent theme/card/navigation writes and pin mutations cannot overwrite one another with stale full preference snapshots (`src/store.ts`, `server/preferences.ts`, `server/app.ts`).
- [ ] Revalidate the selected-session binding when serving every opaque resource handle, and recheck ownership after awaited `get_messages` calls, so a handle resolved in session A cannot be consumed after navigation to session B (`server/app.ts`, `server/runtime.ts`).
- [ ] Buffer or rebind events emitted while `newSession()` still uses its provisional `pending-*` identity; an early extension dialog must be answerable through the final Pi session ID (`server/runtime.ts`).
- [ ] Let the active session's project group honor its persisted collapsed state. Search may still force matching groups open temporarily (`src/components/Nav.tsx`).
- [ ] Discover Pi `bashExecution.fullOutputPath` fields in addition to tool arguments/details (`shared/resource-references.ts`).
- [ ] Replace the mouse-only clickable tool-summary span with valid keyboard-accessible structure, or keep the summary passive and use the existing file button in the card body (`src/components/Transcript.tsx`).
- [ ] Bound image/PDF/audio/video preview size and cancel obsolete resolve/content requests on another selection, pane close, or session switch (`src/api.ts`, `src/store.ts`).

## Efficiency and cleanup

- [ ] Avoid rescanning the full transcript on every streaming delta; cache extraction per stable message or refresh the file list only at meaningful message/tool boundaries (`src/resources.ts`, `shared/resource-references.ts`).
- [ ] Cache the authoritative resource-message projection per session revision so one preview does not repeatedly request and scan all messages; reuse it for embedded-image content delivery (`server/runtime.ts`, `server/resources.ts`).
- [ ] Narrow React store subscriptions and remove per-row whole-store subscriptions in navigation and file rows so token deltas do not rerender unrelated chrome (`src/store.ts`, `src/components/Nav.tsx`, `src/components/ResourcesPane.tsx`).
- [ ] Coalesce settlement-driven session-catalog refreshes; explicit user refresh remains immediate (`src/store.ts`, `server/session-catalog.ts`).
- [ ] Measure host and child-process memory as many sessions are opened, then define an eviction policy only if the measurement justifies one; never evict busy sessions or sessions awaiting extension input (`server/runtime.ts`).
- [ ] Consolidate duplicated tool-path normalization, pin-list updates, byte formatting, and visibility preference enumeration when implementing the related fixes.

## Verification expected

Add deterministic regression tests for both request orderings of preference/pin writes, old-handle rejection after a session switch, early startup extension dialogs, active-group collapse, Bash output discovery, keyboard file-preview access, cancellation/size limits, and stale async ownership. Re-run `npm run check`, `npm run build`, and `git diff --check` after the final edits.
