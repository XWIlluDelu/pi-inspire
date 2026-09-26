---
scope:
  - server/runtime*.ts
  - server/herdr*.ts
  - server/git-inspection.ts
  - server/terminal-history-store.ts
  - server/composer-history.ts
  - server/session-projection.ts
  - src/components/{Welcome,Composer}.tsx
  - src/controllers/{composer,git,resource,transcript-data}-controller.ts
  - src/{store,app-state,composer-history,diff}.ts
  - shared/contracts.ts
  - tests/server/**
  - tests/web/**
---

# Deep review repairs

## Objective

Repair confirmed daily-use correctness and concrete performance defects from the
review of `cd314fb`, preserving [[composer]], [[session-transport]], [[pi-integration]],
[[herdr-enhancement]], [[resource-preview]], and [[terminal]]. The user authorized
precise fixes and justified local rewrites, not speculative fallback layers or
redundant test expansion.

## Result

Complete. The confirmed repairs are implemented; the addressed-reconnect finding
was withdrawn after checking the actual public entry point.

### Input and history ownership

- Welcome uses the same synchronous draft/artifact handoff as Composer. Delayed
  acceptance cannot clear a newer same-text draft; uncertain delivery retries retain
  the original operation and complete payload.
- Retained failed input publishes a reactive count, so Restore appears immediately
  without overwriting the next draft. Model/thinking warnings also retain the
  initiating selection generation across A → B → A switches.
- An accepted prompt stays accepted if projection verification and worker stopping
  both fail. Retirement retains its writer fence; conflict copy no longer claims
  termination before it is confirmed.
- A still-queued prompt receipt checks Pi state to recognize input hooks that finish
  without agent events. Only the same worker, sole pending prompt, and idle/empty
  Pi state can settle it; active/newer work is not cleared.
- A required Host `composerHistoryVersion` separates payload invalidation from
  current-leaf artifact authority. User/compaction/branch-summary changes and
  rewrites invalidate it; ordinary assistant/tool appends do not. The projection
  updates its ancestry anchor incrementally without hashing or duplicating payloads.

### Worker lifetime

- Herdr workers use standard systemd user scopes. A lease captures scope identity
  before the Pi grant; hard stop and recovery use the kernel's recursive
  `cgroup.kill` and wait for an empty scope, including independently grouped Bash
  processes after Pi/bridge death. Ordinary SIGTERM keeps cooperative Pi cleanup.
- Successful availability probing is reused by the enhancement instance; failed
  checks are retryable and explicit Settings queries refresh availability. Actual
  scope ownership is still verified for every launch.
- A same-boot legacy granted lease without scope evidence retains its fence and
  reports a specific diagnostic code and reboot guidance. It is not silently
  migrated or deleted as though detached-tool ownership were known.
- Default direct mode is unchanged and gains no systemd dependency. Its pre-existing
  process-group-only hard-stop limitation for detached tools remains; the earlier
  host-lifecycle document's claim that Pi Bash shared its parent's PGID was corrected.

### Git and persistent output

- A newer Git selection retires an older resource response's cross-pane selection
  authority without cancelling independent Files loading or treating status polling
  as a new user choice.
- Both unified-diff readers use hunk extents to distinguish repeated-sign body lines
  from file headers. Rename comparison includes the selected side's old/new paths,
  while working edits after a staged rename use the working side's own paths.
- Opt-in terminal output history trims from 32 MiB to 24 MiB on overflow, leaving
  append headroom. Default-off behavior and bounded reset/tail semantics are unchanged.

### Withdrawn reconnect finding

`RuntimeController.snapshot(sessionId)` already restores a catalog-backed read-only
slot before delegating to `RuntimeReadController`. The review missed that outer
entry point. The existing idle-reclamation test now checks addressed restoration
without changing Host selection or starting a worker. No production reconnect
fallback was added.

## Verification

- Relevant Runtime/API suites: 226 passed. Composer/frontend/history suites: 156
  passed, plus 27 app/mock tests. Git/resource/output suites: 87 passed.
- The default `npm test` run passed 170 files / 1,775 tests, with two existing skips.
  One legacy-error wording assertion raced its concurrent update; rerunning the
  affected `herdr-enhancement.test.ts` on the final code passed all eight cases.
  Together these checks cover the final default set's 1,776 passing cases. The four
  original baseline failures are resolved without dropping their regression purpose.
- Real Pi 0.87.0 input-hook integration verifies idle settlement followed by an
  ordinary model turn against a synthetic local provider, without paid inference.
- Six real Pi/Bash/systemd cases passed: normal stop, TERM escalation, Pi death,
  bridge death, Host death with bridge self-cleanup, and blocked-bridge Host-crash
  recovery with enhancement disabled. Only the Herdr pane API is a fixture. Each
  proves the separate Bash PGID stops and its test file stops growing. Existing
  transport tests also exercise actual systemd-run exec/leader identity and pipes.
- These scope cases ran on Linux 7.1.12, systemd 262, Node 26.10.0. Capability probing,
  not a version branch, requires writable cgroup v2 `cgroup.kill` and a user manager.
  Unsupported test hosts skip the scope integration explicitly.
- Type checks, release type checks, lint, unused-code checks, front-end build,
  `git diff --check`, and the DocDoki privacy boundary passed.
- The bounded history-fetch regression retains one request across 20 assistant-leaf
  updates, then invalidates on a new user entry. Saturated terminal-log measurement
  reduced five one-byte flushes from about 160 MiB to 24 MiB of logical read/write
  work; the measurement used tmpfs, not physical-disk throughput.

No live Host restart, user Herdr daemon operation, browser automation, or real remote
network benchmark was performed for this repair slice.

## Remaining work

None within this repair slice. The direct-backend hard-stop limitation above is not
claimed fixed by the optional Herdr scope implementation.
