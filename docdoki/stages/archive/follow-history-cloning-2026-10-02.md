---
scope:
  - server/{session-tree,session-projection,session-fork*,runtime*,app,mock,mock-history}.ts
  - server/extensions/inspire-branch-bridge.ts
  - shared/{contracts,branch-node-actions,branch-bridge-protocol,commands}.ts
  - src/{api,store}.ts
  - src/controllers/branch-controller.ts
  - src/components/{BranchTree,ContextPane,AppTopbar,EarlierBranchBanner,CommandPalette}.tsx
  - src/styles/{history,topbar}.css
  - tests/server/{runtime-branching,session-fork,session-tree,branch-bridge-extension,app}.test.ts
  - tests/server/pi-{history-native,branch-bridge}.integration.test.ts
  - tests/web/{branch-tree,branch-controller,branch-store,app}.test.ts*
  - tests/browser/history.spec.ts
---

# History inspection and independent cloning

## Outcome

History inspection and independent copies implement [[session-branches]] and [[workspace-layout]].
The remaining native-parity gaps are tracked in [[follow-pi-native-capability-review-2026-10-02]].

- User prompts lead a compact outline; replies/events and alternate routes disclose on demand at
  actual branch points. Other starts includes hidden metadata-prefix branch points, so editing the
  first input does not hide its original route. Earlier loading survives preview/Back; route opening reveals its endpoint
  once, preserving later manual scrolling and return anchors.
- Paged reads use the authoritative retained projection. Search scans complete text across paths,
  independently of snippets/loaded pages. A bounded containing-prompt header identifies long
  tool-heavy turns without omitting older activity.
- Detail replaces the outline in the same pane. Text loads in bounded chunks; saved images open the
  shared fit/zoom viewer using authenticated entry coordinates, preserving cancellation and focus
  return. Native shell activity exposes command/result and context inclusion in outline/detail/search.
  Search/text/image access share system-body exclusion and structured-key
  redaction; system placeholders do not create blank search results.
- Fork copies ancestors before any retained user input and prepares its text as a destination draft.
  Clone includes its endpoint and opens an empty draft. Topbar, `/clone`, palette and earlier-branch
  notice share Clone. Existing native publication preserves source work/Pending/draft and sends no input.
- Shared native target semantics handle null root parents, before-user/custom-message editing,
  after-node continuation and current-leaf no-op. Summary/label appends and regenerated copy labels
  follow actual SDK results rather than assuming the requested ID remains the final leaf.
- Only explicit same-session Continue/Edit offers summary/instructions and honors skip-summary-prompt.
  Cancellation reconciles native effects and preserves a cooperative worker; unresponsive explicit
  cancellation uses confirmed retirement. Model/shell work, Pending and dialogs block same-session
  continuation, not inspection or independent copying.
- Same-session Edit also owns the confirmed text/material revision: a delayed summary preserves
  newer text, images and references without preventing ordinary editing or changing native navigation.
  Clearing a pending search retires its spinner; retrying a failed detail retains search/pages/Back.
- Text/image reads bind the transcript view at both client and Host; source appends do not invalidate
  unchanged entries. Navigation and source/worker/view replacement retire those reads. Mutations
  retain exact revision freshness. Independent copies retain their
  admitted prefix during ordinary source appends; progress cannot discard an already-published copy.
  Successful context changes close only the narrow contextual drawer; preview/Back do not. At 320px,
  secondary wording yields to session identity while Git keeps its glyph/count and accessible name.

## Evidence

- Explicit installed **Pi 1.0.0** runs of
  `tests/server/pi-{branch-bridge,history-native}.integration.test.ts` passed root/custom edits,
  response continuation, native summary/label effects, endpoint-inclusive Clone/provenance and empty-
  path header-only Clone. A local streamed summary cancelled without appending, retained PID/extension
  locals and source draft/leaf, then succeeded on retry. Host SDK agent/session roots are isolated
  before Runtime construction, as are worker roots; tests clean temporary state/processes.
- Session-tree, Runtime/bridge/fork/API regressions passed complete old/alternate access, full-text
  matches, containing prompts, redaction, admission, image/text routes and source-preserving publication.
  Branch component/controller tests passed paging, search/scroll/focus return, optional summary/cancel,
  draft boundaries and copy completion during source append versus replaced selection.
- Fresh-build `tests/browser/history.spec.ts` passed populated desktop and 390px touch flows using a
  600-input fixture, a 140-event turn, long retained text and an alternate route. Evidence covers
  earlier/alternate access, full preview/search/Back, continuation, distinct Fork/Clone drafts, all
  Clone entry points and no prompt during browsing/copy. A presentation pass covers endpoint visibility,
  quiet current-position labeling, return anchors and 320px identity layout.
- Repair regressions in `branch-tree`, `branch-controller` and `branch-store` cover search retirement,
  selected-detail retry, draft revisions and unchanged native/view action ownership. Fresh-build
  desktop/390px Chromium operations cover delayed-summary editing with newer text/image, shell
  outline/search, selected retry/Back, shared image open/zoom/close/focus return and actual full-log
  resource resolution. Persisted native shell projection is also checked with explicitly selected
  Pi 1.0.0 in `pi-operation-lifecycle.integration.test.ts`.
- Installed Pi 1.0 text/image reads succeeded after a native Bash append advanced branch revision;
  the focused Runtime regression also rejects reads after navigation. Previously those retained
  reads returned 409 despite unchanged entry content. A component regression follows an original
  first-input route through Other starts without native navigation.
- History Escape ignores React-bubbled events from portals outside the detail's DOM subtree.
  The existing desktop/390px image-viewer case verifies both button closure and Escape closure:
  Escape leaves the same selected detail open and restores its image opener's focus. The shared
  modal design is unchanged. Focused `branch-tree` tests passed 14/14; the viewer cases passed 2/2
  against the rebuilt client. Screenshots include `{desktop,narrow}-image-escape.png`.
- Screenshots under `output/playwright/history/` include desktop/narrow alternate outlines, populated
  previews/destinations and `narrow-320-topbar.png`. Browser fixtures establish UX; actual Pi checks
  establish action semantics. Typecheck, scoped formatting and diff checks passed at acceptance.

## Remaining boundary

Label editing, secondary filters and graph editing are outside this unit. Independent publication
retains its healthy materialized current-format source requirement. The native-capability inventory
retains other gaps without expanding the default toolbar.
