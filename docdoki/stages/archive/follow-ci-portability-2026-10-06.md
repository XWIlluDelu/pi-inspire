---
scope:
  - server/user-environment.mjs
  - server/herdr-process-group.ts
  - server/mock*.ts
  - tests/portable/user-environment.test.mjs
  - tests/user-environment-launcher.test.ts
  - tests/server/**
  - tests/browser/**
  - tests/web/resources-pane.test.tsx
---

# CI portability and regression repairs

Completed the runtime and cross-platform test repairs following [[maintainability-review]].
[Final native CI](https://github.com/XWIlluDelu/pi-inspire/actions/runs/37411420190) passed all seven
jobs, including macOS/Windows core and Chromium and all three release-package checks.

Reusable findings, test boundaries and integrated evidence are retained in
[[maintainability-review]]. Environment-export contracts are in [[host-lifecycle]]; no high-numbered
inherited descriptor is required. No remaining implementation actions belong to this stage.
