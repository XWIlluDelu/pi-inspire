---
scope:
  - src/{session-drafts,composer-history,composer-keyboard,api,app-state,store}.ts
  - src/controllers/{composer-controller,transcript-data-controller,resource-controller}.ts
  - src/components/{Composer,ComposerInput,Welcome}.tsx
  - src/styles/composer.css
  - server/{session-projection,composer-history,runtime-composer-artifacts,runtime-reads,resources,runtime,app,mock}.ts
  - shared/{contracts,resource-references,composer-artifact-references}.ts
  - tests/server/*history*.test.ts
  - tests/server/{session-projection,runtime-composer-artifacts}.test.ts
  - tests/web/*composer*.test.ts*
  - tests/web/session-drafts.test.ts
  - tests/shared/composer-artifact-references.test.ts
  - tests/browser/workbench.spec.ts
  - docdoki/specs/composer.md
---

# Prompt history, drafts, and expanded editing

## Outcome

Retained prompt history, tab-local text drafts and overflow expansion implement [[composer]].

- `SessionProjection.composerHistoryMessages` reads retained user entries on the selected branch,
  separately from compacted model context. Recall survives compaction/reopen, preserving the 100-entry
  bound, trimming, consecutive deduplication, paging and keyboard restoration. History versions follow
  user-entry identity/replacement rather than assistant appends or compaction.
- Recalled images/files use entry identity and part/reference coordinates. Delivery rechecks branch,
  incarnation, effective leaf, membership, upload ownership and workspace realpaths. History previews
  have a separate resource namespace, so pre-compaction images cannot alias later transcript images.
- Text drafts use per-origin tab-local session storage, separately keyed for sessions and start.
  Storage refusal retains in-memory switching. Handoff, clear, transfer and deletion retire persisted
  text; unknown/failed delivery uses the same store. Temporary history previews are not saved, nor are
  attachment bytes/handles or project-file chips.
- Shared `ComposerInput` reveals Expand only on actual scrolling. The same textarea keeps focus,
  selection and artifacts; expanded mode persists until Collapse even after shortening. Geometry
  follows content, fonts, container/window resize and the visual viewport. The gutter appears only
  with the control; delayed selection events cannot reopen dismissed completion without a text/caret change.
- Selected inline `@` references stay committed while ordinary prose follows, without removing spaces
  from unfinished/quoted queries. Completion applies its caret before paint; later typing retires
  old selection callbacks. Seeded command preparation puts the initial caret after its invocation
  without resetting ordinary selections.

## Evidence

- Focused history/projection/resource/artifact checks passed for live compaction, cold reopen,
  branch isolation, original image bytes, unchanged visible-transcript image coordinates, ownership
  refusal and paging/version behavior. Draft/controller tests cover storage refusal, clear/delete,
  partition ownership, history browsing, ordinary delivery and recovery.
- Fresh-build isolated Chromium checks in `tests/browser/workbench.spec.ts` cover reload, session
  switching, confirmed sending/clearing, active/start editing and coexistence with Pending/completion.
  Reload before definitive send acceptance retains the existing unknown-delivery recovery behavior.
- Expansion evidence covers 1440px and 390px, resize-only wrapping, actual scroll overflow, manual
  collapse, shortened expanded text, the same DOM textarea, backward selection, retained attachments
  and a touch context with 44px controls/multiline Return.
- The visual-viewport regression keeps the main column at 900px while shrinking the viewport to 400px:
  expanded input becomes 216px, reserving 120px for controls and 64px around the editor; collapse returns
  to 160px. This supplements the normal-viewport browser checks.
- Composer/command regressions cover committed-reference editing, unfinished spaced paths and
  preparation caret ownership. Fresh-build `command-ux.spec.ts` selects an actual file and immediately
  types the continuation at desktop/390px touch widths, asserting intact text and no reopened picker.
- Typecheck, scoped lint and diff checks passed at acceptance. Pending-image ownership and its native
  gate are recorded separately in [[follow-pending-input-recovery-2026-10-02]].
