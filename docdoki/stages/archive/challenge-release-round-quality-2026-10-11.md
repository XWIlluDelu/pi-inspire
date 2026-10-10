---
scope:
  - src/**
  - server/**
  - shared/**
  - tests/**
  - scripts/**
  - docs/**
  - docdoki/**
---

# Pi 1.0 review-round quality audit

## Outcome

Completed the review of the 95-commit round after `36fb3ac`: core reliability/rendering repairs,
native capability coverage and accepted frontend refinements. The resulting design remains aligned
with [[northstar]]: Pi owns execution and native state; Inspire adapts supported interfaces and
renders recoverable projections. Existing capability gaps retain their owners below.

The audit retained three demonstrated production repairs, focused test maintenance and documentation
consolidation. The earlier 95 commits were grouped into 56 coherent outcomes, followed by four audit
commits. Consolidation preserves the final file tree and the earlier base; no release tags changed.

## Verified repairs

| Issue | Cause and retained change |
| --- | --- |
| Latest live tool output disappeared above the generic projection limit | The 250,000-character head cap ran before tail selection. The Host now creates the bounded `outputPreview` from native output once; both the browser and reconnect snapshot use it. Live content is not transported again beside the preview. Details, child calls and completed results retain their contracts. |
| Session switching issued duplicate Git status requests | A session-keyed topbar child unmounted and re-registered an existing Git observer. The stable topbar now owns that subscription; the store still refreshes on session changes and retires non-repository observation. |
| Files selected the wrong row during preview reauthorization | Tree, search and Recent selection ignored the preserved canonical workspace path while the new lease loaded or failed. They now use the same retained path as the resource lifecycle. |

The first repair is covered by character- and line-bound event/snapshot cases in
`tests/server/runtime-projection.test.ts`; frontend tests verify the Host DTO and copy semantics.
`tests/web/git-store.test.ts` exercises switching through repository and non-repository sessions.
Existing preview-lifecycle cases cover compaction, view rewrites, incarnation resets and refusal.

Measurements and workloads are recorded in [[performance-evidence]].

## Code and test maintenance

- Removed five CSS-spelling cases that did not prove browser layout or cascade behavior. Kept
  asset/token checks and the actual interaction, geometry and ownership regressions.
- Repaired stale touch-focus, CodeMode, completion-name and compaction-label assertions. CodeMode
  continuity now checks conversation scrolling and a visible row anchor rather than an inert inner
  `scrollTop`.
- Moved the Settings dropdown case into `settings-layout.spec.ts`, with explicit session/Behavior
  setup and a real clipping precondition. Empty-state fixtures now own bootstrap and live snapshots.
- Retained desktop-light and 320px-dark compaction cases instead of repeating the whole flow in six
  viewport/theme combinations.
- Made the mocked non-repository Git failure independent of the machine's temporary-directory Git
  metadata; disambiguated the session-row locator from its direct Pin/Hide actions.
- Knip found no unused production surface. The retained parser-worker recovery, resource boundaries
  and distinct native/component/browser tests have concrete failure modes; no broader removal or
  abstraction was warranted.

## Documentation

The frontend stage is now a 90-line completed outcomes record rather than a 1,056-line batch diary.
The overview no longer lists accepted work as pending. Guides reflect focused Models editors,
Pending navigation, image-restoring Fork, settings scope/persistence and actual CodeMode scrolling.
Contracts describe the canonical live-output projection; rewritten commit references remain usable.

## Verification

- Full Vitest run: 243 files; 2,497 passed, 2 existing skips.
- Chromium: all 147 retained scenarios covered. The complete run passed 138; repaired cases passed
  targeted reruns against the current frontend. Desktop/touch ownership, narrow geometry and native
  fixtures were also checked by the focused reviews.
- Production frontend build, type checking, project lint/format checks and Knip passed.
- Wiki/relative links and the DocDoki privacy boundary passed after document moves.
- History consolidation preserved the complete final tree before reference updates; publication
  checks the exact reviewed remote head.

The production frontend was verified in an isolated build. The daily Host was not restarted during
the review; the canonical output DTO must activate with its matching frontend on the next Host
restart and browser refresh. The source launcher detects the changed client sources and rebuilds them.

## Remaining owners

- [[follow-pi-native-capability-review-2026-10-02]]: native persistence feedback, resource diagnostics,
  cancellation and remaining public-API/image-copy work.
- [[follow-file-browsing-experience-2026-08-24]]: Notebook kernel-name inference and deferred Files
  design questions.
- [[follow-native-command-surface-2026-09-04]]: transcript inventory for the undecided compact-success
  receipt proposal.
- [[follow-frontend-refinement-2026-10-07]]: accepted frontend outcomes and retained design reasons.
