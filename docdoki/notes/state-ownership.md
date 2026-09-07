# State and operation ownership

## Resource and terminal ownership review

### Scope and decisions

The review identified three local defects: resource reads followed global Host selection, terminal mutations could write into another project's pane, and VS Code file URIs retained the URL slash before Windows drive letters. It also identified unconditional preview index rebuilds and the unused terminal `replayModeRef`.

- `RuntimeReadController` now addresses the requested open slot. Context reconciliation and lazy message reads retain slot-registration, view, and revision checks without reading or changing global selection. The mock runtime follows the same addressed contract.
- `TerminalCatalogController` is local to one pane project/reload generation. Full reads and mutation receipts share project, epoch, revision, and ID-merge rules. Partial receipts record a revision high-water mark, not a complete inventory: equal-revision full responses still reconcile membership/order. Epoch changes require a full catalog; previously replaced epochs are rejected. Obsolete success/failure/finally callbacks cannot change selection, errors, creation state, or ordering in the current project. Optimistic rollback only restores its exact unchanged state.
- VS Code paths are converted through a file URL and Node's native URL-to-path conversion, preserving Windows drives and POSIX absolute paths.
- Following the review's proposed tradeoff, content requests reuse the five-second project-index cache and shared in-flight scans. Ignore-rule changes become effective on cache expiry or explicit Files refresh. Per-request branch, realpath, and pinned-object checks remain; a serving-time missing indexed file still invalidates the cache. No measured latency improvement is claimed.
- The write-only replay ref was removed. No broader request framework, terminal protocol change, or test deletion was needed.

Contracts: [[resource-preview]] and [[terminal]].
