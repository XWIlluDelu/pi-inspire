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

## Outcome

Complete in `a67f4b9`. Contracts: [[composer]], [[session-transport]], [[pi-integration]],
[[herdr-enhancement]], [[resource-preview]], and [[terminal]].

### Input and history

- Welcome and Composer share synchronous draft/artifact handoff. Late acceptance preserves newer
  drafts; uncertain retries keep the original operation and payload. Failed-input recovery updates
  reactively, and model/thinking warnings retain their initiating selection generation.
- Accepted input stays accepted if projection verification or worker stopping fails. An input hook
  that finishes without agent events can settle queued admission only through an idle/empty Pi
  state read owned by the same worker and sole pending prompt.
- `composerHistoryVersion` invalidates on user/summary changes, rewrites, and relevant branch
  changes, not ordinary assistant/tool appends. Projection updates its ancestry anchor incrementally.

### Worker lifetime

- Enhanced Pi and detached Bash descendants share a standard systemd user scope. Lease identity
  precedes the grant; forced stop/recovery uses `cgroup.kill` and waits for an empty scope.
  Normal stop starts with cooperative SIGTERM.
- Availability reuses successful scope probes, retries failed probes, and refreshes on explicit
  Settings queries. Every launch still verifies its own scope.
- Same-boot legacy granted leases without scope evidence retain the fence and report reboot
  guidance. Direct POSIX mode keeps its process-group-only hard-stop behavior and no systemd
  dependency; [[host-lifecycle]] distinguishes its detached-tool limitation.

### Git and output history

- New Git selection retires older resource-response selection authority while allowing independent
  Files loading to finish. Diff parsing respects hunk extents; rename comparisons use each side's
  own paths.
- Opt-in terminal output history trims from 32 MiB to 24 MiB on overflow, leaving append headroom.
  On tmpfs, five saturated one-byte flushes fell from about 160 MiB to 24 MiB of logical I/O.

The suspected addressed-reconnect gap was withdrawn: the public snapshot method already restores
a catalog-backed read-only slot. [[async-ownership-review]] records that entry-point distinction.
The idle-reclamation regression now checks addressed restoration without selecting or starting Pi.

## Recorded verification

- The default run recorded 1,775 passing tests across 170 passing files and two skips. One legacy
  diagnostic-text assertion needed updating; the final `herdr-enhancement.test.ts` rerun passed
  all eight cases.
- Real Pi 0.87.0 input-hook integration covered idle settlement followed by a normal model turn
  using a local synthetic provider.
- Six real Pi/Bash/systemd cases covered normal stop, TERM escalation, Pi death, bridge death, Host
  death with bridge cleanup, and blocked-bridge Host-crash recovery with enhancement disabled.
  The pane API was a fixture; each case checked that detached Bash stopped and its file stopped
  growing. Environment: Linux 7.1.12, systemd 262, Node 26.10.0.
- The history-fetch regression retained one request across 20 assistant updates and invalidated on
  new user input. Type/release checks, lint, unused-code analysis, Web build, and privacy checks passed.
