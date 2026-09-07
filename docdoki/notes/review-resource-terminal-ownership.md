# Resource and terminal ownership review

## Scope and decisions

The review of `f37f126de607610a73903858a1a6d5dd9ce15c5a` identified three local defects: resource reads followed global Host selection, terminal mutations could write into another project's pane, and VS Code file URIs retained the URL slash before Windows drive letters. It also identified unconditional preview index rebuilds and the unused terminal `replayModeRef`.

- `RuntimeReadController` now addresses the requested open slot. Context reconciliation and lazy message reads retain slot-registration, view, and revision checks without reading or changing global selection. The mock runtime follows the same addressed contract.
- `TerminalCatalogController` is local to one pane project/reload generation. Full reads and mutation receipts share project, epoch, revision, and ID-merge rules. Partial receipts record a revision high-water mark, not a complete inventory: equal-revision full responses still reconcile membership/order. Epoch changes require a full catalog; previously replaced epochs are rejected. Obsolete success/failure/finally callbacks cannot change selection, errors, creation state, or ordering in the current project. Optimistic rollback only restores its exact unchanged state.
- VS Code paths are converted through a file URL and Node's native URL-to-path conversion, preserving Windows drives and POSIX absolute paths.
- Following the review's proposed tradeoff, content requests reuse the five-second project-index cache and shared in-flight scans. Ignore-rule changes become effective on cache expiry or explicit Files refresh. Per-request branch, realpath, and pinned-object checks remain; a serving-time missing indexed file still invalidates the cache. No measured latency improvement is claimed.
- The write-only replay ref was removed. No broader request framework, terminal protocol change, or test deletion was needed.

Contracts: [[resource-preview]] and [[terminal]].

## Verification

Verified on Linux with Node 22.23.2:

- `npm run check`: formatting, lint/import boundaries, TypeScript, unused-code check, web build, 17 portable checks, 1,195 passing unit/integration tests (one skipped), and six launcher checks (one skipped).
- Six targeted files: 184 passing tests, including real RuntimeController/ResourceStore addressed reads, authenticated resource routes, Windows path algorithms, cache reuse/expiry/refresh, and terminal pane delayed responses.
- `tests/web/terminal-pane.test.tsx` exercises the real component with delayed APIs: create, duplicate, reopen, reorder, close, restart, rename, failure/rollback, A→B→A, reload, stale polling, and equal-revision reconciliation. Terminal rendering is stubbed for these deterministic races.
- `tests/server/resources.test.ts` counts Git index commands: resolve builds the two `ls-files` calls; three concurrent revalidations reuse them; expiry or refresh rebuilds once and revokes newly ignored content. Tests retain explicit-citation fallback and literal-workspace-name boundaries.
- `tests/server/resources-windows-paths.test.ts` runs the actual parser against Node's Windows path and file-URL algorithms on Linux. Native resource URI serving is additionally covered using the running platform's paths.
- After an explicit production build (`node scripts/build-web.mjs`), all 25 Chromium checks passed, including real project PTY detach/reconnect, terminal menus, and file previews against the mock Pi Host.

The first browser run used a generated bundle containing development React and failed the existing narrow image focus-restoration check (also failed three isolated repeats). Both baseline and patched isolated production builds passed; rebuilding production in the working tree made the full browser suite pass without modifying image/focus code. This is not evidence that the development-build focus behavior is fixed.

No real Pi provider, SSH tunnel, or native Windows Host was exercised in this repair. Browser terminal checks exercise local PTYs; Windows path tests establish parsing, not Windows filesystem/PTY deployment.
