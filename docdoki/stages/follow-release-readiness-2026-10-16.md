---
scope:
  - .github/workflows/ci.yml
  - tests/browser/**
  - tests/launcher.test.ts
  - tests/server/{mock,model-workflow.integration,pi-session-activity}.test.ts
  - tests/web/{composer-delivery,overlay-and-palette,resources-pane}.test.tsx
  - server/mock*.ts
  - src/styles/composer.css
  - package-lock.json
---

# Complete v0.5.5 validation

## Objective

Complete CI on the finished source revision, then replace today's interim
`v0.5.5` Git tag with that revision. npm publication is outside this task.

## Current state

- The interim tag still resolves to `227c7de2`. The candidate includes the
  feedback fixes, existing native Pi control, and Host restart session retention.
  No GitHub Release or public npm publication exists for this version.
- Touch attachment centers remain clear of removal controls; [[composer]] holds
  the contract. Express now resolves `proxy-addr` 2.0.8, fixing
  GHSA-jqcg-44mw-7w3h; the production dependency audit reports zero vulnerabilities.
- Destructive browser tests own their cloned sessions. Selection geometry owns
  its collapse preferences locally, so failed assertions cannot hide the shared
  catalog from later cases. Mock History appends publish new entry arrays, keeping
  immutable tree indexes valid; two server regressions cover warm reads.
- Browser fixtures wait for viewport layout and session-detail admission before
  measuring or injecting events. Geometry allows subpixel/native font precision.
  The 320px drawer checks the full available title column rather than assuming
  390px geometry. Terminal selection handles native CRLF, and the pinch fixture
  actually lifts one finger and verifies the remaining finger pans without zoom.
- Lazy Settings and recent-file assertions wait for their own surfaces. Native
  metadata tests allow the isolated worker's deadline and settle queries before
  removing their workspace. Cold launcher preparation has a separate budget and
  does not repeatedly spawn status processes before a Host state file exists.
- [Candidate CI](https://github.com/XWIlluDelu/pi-inspire/actions/runs/38902925284)
  passed all three full Chromium suites, Linux/macOS core checks, launcher checks,
  all three packaged-release jobs and size reporting. Its only remaining failure
  was a Windows heartbeat fixture polling a file while it was being replaced.
  The fixture now observes and awaits the real atomic publish before reading,
  and asserts the precise heartbeat timestamp. All five activity cases and
  types/lint pass locally. Full CI on the completed revision remains pending.

## Next actions

- [x] Repair known failures while retaining their behavioral assertions.
- [x] Recheck affected behavior and production dependency auditing.
- [ ] Push the completed candidate and obtain passing GitHub jobs on Linux,
  macOS and Windows, including release verification and size reporting.
- [ ] Close the stage and complete final revision validation.
- [ ] Replace local and remote `v0.5.5` only after its target passes; verify the
  target and remove temporary investigation artifacts.
