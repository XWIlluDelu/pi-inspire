---
scope:
  - server/host-{dirs,hidden-dirs}.ts
  - server/app.ts
  - shared/contracts.ts
  - src/{api,store}.ts
  - src/components/DirectoryPicker.tsx
  - src/styles/settings-overlays.css
  - tests/server/host-{dirs,hidden-dirs}.test.ts
  - tests/server/app.test.ts
  - tests/web/directory-picker.test.tsx
  - tests/web/api.test.ts
---

# Hidden project directories

## Objective

Make hidden project directories reachable from New session with predictable host-side visibility across Linux, macOS, and Windows, under [[workbench]].

## Final state

Implemented the default-off checkbox, explicit API query, dot-name plus native Hidden/UF_HIDDEN filtering, and latest-request/dismissal ownership. Direct hidden paths, directory links, native paths, and root navigation remain supported. Pending or failed loads cannot confirm a stale directory.

The six targeted Node 22 suites passed 113 tests with one conditional native-platform skip. Typecheck, lint, production build, and isolated Chromium desktop/narrow/landscape checks passed for the changed behavior. Native Windows/macOS execution is left to the existing CI matrix; no daily-use Host restart or release deployment was performed.

Contract is in [[workbench]]; implementation reasons, checks, platform limits, and the pre-existing light primary-button contrast finding are retained in [[hidden-project-directories]]. No remaining implementation actions in this stream.
