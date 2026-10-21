---
scope:
  - README.md
  - CHANGELOG.md
  - package.json
  - package-lock.json
  - docs/**
---

# Prepare 0.6.0

## Objective

Prepare an accurate 0.6.0 candidate, user documentation and real application screenshots.
This stage does not authorize a tag, npm publication or GitHub release.

## Current state

- The existing release baseline is annotated tag `v0.5.5`. The documented distribution path is
  `release:verify` → `npm pack` → tarball installation; there is no release workflow to replace.
  The public npm registry currently returns 404 for `inspire-pi-gui`.
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
- [ ] Confirm final-source CI and three-platform installed-package checks after the test-fixture
  corrections. Run 39568826267 passes all three package checks but exposes the unit/clipboard
  issues below; it is not a release-ready result. No release or tag is authorized before the gates close.
- [x] Prepare a concise changelog from the integrated v0.5.5..candidate diff, retaining upgrade
  requirements and actual capability limits. The existing tarball workflow is unchanged.
- [x] Build the candidate and capture the existing eight filenames with a real isolated application
  and synthetic content, including the 390px mobile image. Inspect pixels, text, version and privacy.
- [ ] Obtain the separate release/tag go-ahead after these gates. Production Host restart remains an
  operator action; terminal migration that ends PTYs requires explicit approval.
