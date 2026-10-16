---
scope:
  - .github/workflows/ci.yml
  - tests/browser/**
  - server/mock*.ts
  - src/styles/composer.css
  - tests/web/{composer-delivery,overlay-and-palette,resources-pane}.test.tsx
  - tests/server/mock.test.ts
  - package-lock.json
---

# Complete v0.5.5 validation

## Objective

Complete CI on the finished source revision, then replace today's interim `v0.5.5`
Git tag with that revision. This does not authorize publishing a new npm package.

## Current state

- The interim tag resolves to `227c7de2`. Local work through `e4bf86ac` includes
  feedback fixes, existing native Pi control, and Host restart session retention.
- GitHub has no release for the tag; the public npm registry has no `inspire-pi-gui`
  publication. The existing tag has not been changed.
- [The interim CI run](https://github.com/XWIlluDelu/pi-inspire/actions/runs/38873947081)
  passed all three release-package jobs and size reporting. Linux, macOS and Windows
  browser suites failed; recurring failures involve fixture session navigation and
  History, with separate image hit-target and geometry failures.
- The shared destructive test now clones its own persisted session. The History
  fixture survives the suite; usage events wait for the selected session's
  handshake, geometry checks arrange their own scroll position and allow DOMRect
  precision, and a failed send asserts the current notification channel.
- Coarse-pointer attachment tiles now keep preview centers clear of corner
  removal buttons; [[composer]] specifies the layout.
- Static, portable, unit/integration, launcher, build and packaged-release checks
  pass locally. The first full browser run passed 233/237 cases; order-sensitive
  failures traced to an in-place mock History append reusing an immutable tree
  index, and positioning earlier code while Follow latest was still active.
  Both causes are repaired and their ordered reproductions now pass. Two unit
  regressions cover warm History reads through appending and settlement.
  The subsequent full run passed 236/237 cases; its sole failure compared a
  40.0000305px DOMRect with exactly 40px. Shell, widget and capsule geometry now
  uses subpixel-aware comparisons; all ten affected browser cases pass.
- Candidate CI passed all three release-package jobs and size reporting.
  The superseded run was cancelled after the browser failures were identified.
  Windows exposed two readiness races: lazy Settings loading and independently
  resolved recent-file observations. Their assertions now await the owning surface
  rather than assuming another surface's readiness. Final full CI remains pending.
- The lockfile now selects `proxy-addr` 2.0.8 for Express, fixing advisory
  GHSA-jqcg-44mw-7w3h. Production dependency auditing reports zero vulnerabilities.

## Next actions

- [x] Repair the shared causes of browser failures while preserving behavioral assertions.
- [ ] Run the complete current validation suite and production dependency audit.
- [ ] Push the completed candidate and obtain passing GitHub jobs on all supported platforms,
  including release verification and size reporting.
- [ ] Replace the local and remote `v0.5.5` tag only after that revision passes;
  verify its final target and remove temporary investigation artifacts.
