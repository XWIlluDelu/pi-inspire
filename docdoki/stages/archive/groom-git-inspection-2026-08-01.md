---
scope:
  - server/git-inspection.ts
  - server/app.ts
  - server/project-files.ts
  - shared/contracts.ts
  - src/api.ts
  - src/store.ts
  - src/components/Nav.tsx
  - src/components/ResourcesPane.tsx
  - src/styles.css
  - tests/server/**
  - tests/web/**
---

# Git-aware file inspection

## Objective

Add read-only repository status and bounded diffs to the existing file surfaces without turning inspire into a Git mutation workbench.

## Outcome

- A session-addressed `GitInspectionService` projects repository identity and bounded porcelain-v2 status with raw-byte base64url path identities, deterministic grouped facets, strict grammar, and truthful non-repository, unborn, detached, rename/copy, conflict, submodule, binary, deletion, truncation, and failure states.
- Every diff is authorized against a fresh status result. Git runs through argument arrays with a sanitized environment/config, literal pathspecs, no external diff/textconv, explicit byte/time/cardinality caps, abort propagation, and Linux process-group cleanup.
- Untracked content is deliberately not opened. This removes symlink, FIFO, device, and directory-swap filesystem-read authority rather than attempting a lexical containment check.
- The existing contextual pane now owns `Files`, `Changes`, and `Branches` modes. Changes reuses the detail region, refreshes visible status and the selected diff, retains last-good data through transient failure, and decorates the one existing workspace tree.
- Accessible change rows distinguish staged, unstaged, and conflict facets and describe copied versus renamed sources. High-cardinality lists and diffs expose explicit truncation rather than unbounded rendering.
- No Git mutation, history, staging, restore, checkout, fetch, push, blame, or repository-management endpoint exists.

## Decisions

- Git information enriches existing file/resource ownership; it does not create a second project tree or a general Git client.
- Display paths never authorize commands or reads. Opaque raw-byte identities plus fresh server status do.
- Repository-configured executables and inherited Git selection/config variables are excluded from the inspection process.
- Porcelain-v2 validation accepts Git's paired unknown `branch.ab +? -?` form under `--no-ahead-behind` while rejecting mixed or malformed headers, facetless ordinary records, and impossible conflict codes.

## Verified

- Real and adversarial repositories cover rename, copy, conflict, submodule, binary, arbitrary bytes, newline-containing cwd, configured fsmonitor hooks, descendants surviving timeout attempts, symlink/FIFO/device/directory swaps, stale selected diff refresh, forged IDs, malformed porcelain, and worst-case response cardinality.
- Authenticated routes resolve cwd from the addressed open session; route tests prove unsupported mutation/history paths return 404.
- Focused server/store/component tests, the final repository-wide 491-test validation, TypeScript check, production build, real Chromium status/diff smoke, and diff hygiene pass.

## Residual boundary

Process-group descendant containment is attested on the supported Linux host. Other operating systems would need their own process-tree containment witness before claiming equivalent hostile-hook cleanup.
