---
scope:
  - README.md
  - CHANGELOG.md
  - package.json
  - package-lock.json
  - docs/**
---

# Tag 0.6.0

## Objective

Record annotated tag v0.6.0 for the verified source, user documentation and real application
screenshots. The requested deliverable is the tag, not a GitHub Release or uploaded assets.
Production activation remains a separate operator action.

## Current state

- Annotated tag [v0.6.0](https://github.com/XWIlluDelu/pi-inspire/tree/v0.6.0) was created on
  2026-10-21 and resolves to `f67d6eef659ca4500bf39167c8460813d5d2a85d`. All seven jobs in
  [CI run 39574685523](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39574685523) pass,
  including the three installed-package verifications. Production dependency audit reports zero
  advisories. No whole-suite rerun was needed to create the tag.
- Previous baseline: annotated tag `v0.5.5`. Version 0.6.0 has no GitHub Release or uploaded
  release-asset distribution. The documented local package flow remains
  `release:verify` → `npm pack` → tarball installation; no npm publication was introduced.
- Exact-source package verification used the committed prepack mechanism and lockfile dependencies.
  Documentation/status corrections do not move the tag. The running Host and production build
  are not upgraded.
- Merge `0ed3d6c` preserves the published quality line and the completed PWA/workbench refinements
  without rewriting either history. Candidate scope is fixed; package.json, both root lockfile
  versions and the documented tarball name now use 0.6.0. CHANGELOG.md is included in the package.
- README already describes most current capabilities. Targeted documentation now corrects the
  System → Host restart location, stopped/failed replies, terminal preference scope and
  non-destructive connection recovery. Existing protocol-upgrade, Trash recovery and attachment
  migration instructions remain relevant.
- [[follow-project-quality-2026-10-21]] records CI and the terminal recovery/lifecycle corrections.
  The reviewed range since v0.5.5 includes portable Host lifecycle, authenticated terminal IPC,
  native Trash/attachment continuity, external-writer fencing, Pending recovery and responsive
  reading/input behavior. Release notes must distinguish strengthened behavior from capabilities
  already present in 0.5.5.
- All eight README images are replaced from one isolated production client build of the current
  0.6.0 source. Settings shows its real 0.6.0 footer and current control text. Each image was checked
  for pixel composition, readable text, loaded assets and private data. Mobile uses a touch/coarse
  pointer context and a 390×844 CSS-pixel capture. No generated UI or edited version label is used.
  The production Host and its existing dist/build marker are not used or changed for photography.
- Combined UI/icon/package-manifest targets pass (115 cases); five selected browser cases pass
  without retries for update states, code focus/copy, command preparation, MCP saving and terminal
  errors. Earlier terminal/Settings checks overlap this evidence and are not added to its count.
- Exact candidate `914c24d` passes isolated installed-package verification at 0.6.0. The public
  tarball includes the changelog, eight new screenshots, licenses and production runtime, not tests
  or source-only modules. Its temporary source snapshot and processes are removed.
- Run 39561923512 exposes sixteen stale terminal-notice checks: four compare the entire new card
  with body text and click its old whole-button target; twelve color probes still build the old
  error button. Updated checks preserve exact body text, independent dismissal, viewport containment
  and 4.5:1 text contrast, and assert shared title/body/icon/border roles. All sixteen pass locally
  without retries. Only non-shipped tests and this stage change after 914c24d; the UI, package inputs
  and verified screenshots are unchanged. The argument-menu retry is retained as a separate flaky.
- Run 39568826267 confirms a stale MCP Save label on all platforms and a non-atomic test probe on
  Linux. The probe now publishes by same-directory rename, each agent read uses one snapshot, and
  readiness waits for both state and PTY output within the existing deadlines. Both affected test
  files pass all 23 cases; cwd, project scope, revision and save payload assertions remain intact.
- Windows additionally exposes native CRLF in the terminal-error clipboard test. Both failed traces
  record the complete message with CRLF, not lost content. The assertion now normalizes only CRLF,
  retaining complete text/whitespace equality like the existing assistant-error copy test. Its
  isolated Chromium regression passes. Product code and the eight verified screenshots are unchanged.

## Release gates and next actions

- [x] Fix the candidate source boundary and synchronize package.json, both root lockfile version
  entries and the documented tarball name. A local candidate build is not the running Host version.
- [x] Confirm exact-source CI and three-platform installed-package checks: run 39574685523 at
  f67d6ee passes all seven jobs. Earlier failed runs are diagnostic history, not current blockers.
- [x] Prepare a concise changelog from the integrated v0.5.5..candidate diff, retaining upgrade
  requirements and actual capability limits. The existing tarball workflow is unchanged.
- [x] Build the candidate and capture the existing eight filenames with a real isolated application
  and synthetic content, including the 390px mobile image. Inspect pixels, text, version and privacy.
- [x] Create annotated tag v0.6.0. No GitHub Release, uploaded assets or npm publication are
  requested for this version.
- Production Host restart remains an operator action. No Host, daemon, service unit or existing PTY
  was operated on during tagging; migrating an incompatible old daemon still requires explicit
  approval to end its terminal work.
