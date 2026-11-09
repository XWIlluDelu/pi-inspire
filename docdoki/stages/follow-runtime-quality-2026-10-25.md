---
scope:
  - package*.json
  - src/**
  - server/**
  - tests/**
  - scripts/**
  - docs/**
---

# Runtime quality and device acceptance

## Objective

Keep native Pi ownership, asynchronous operation lifetimes and responsive reading consistent
with [[northstar]]. Current contracts live in [[session-persistence]], [[session-transport]],
[[pi-integration]], [[notifications]], [[terminal]] and [[composer]].

## Current state

- Navigation starts independently of notification enrollment. Device intent, Host settings,
  receiver replacement and delivery have separate owners.
- Model reads cannot replace newer session choices. Pending recovery waits for receipts and
  transcript convergence without replaying a mutation whose acceptance is unknown.
- Worker startup, branch navigation and retirement recheck their original owner after asynchronous
  reconciliation. Shutdown rejects new work and drains admitted operations.
- External Pi remains outside Host process ownership. Terminal observer failures preserve the
  control lease, geometry and independently running process.
- Direct native Bash persistence uses the same verified append boundary as other native entries.
  Zsh command/cwd markers round-trip percent signs and control characters.
- Worker-witnessed appends reconcile ordinary message identities across interleaved metadata and
  disk-before-completion observation, retiring their live overlays without coalescing repeated input.
  Completion claims share identity with their queued presentation, including when lifecycle
  reconciliation observes persistence before the live overlay exists.
- Compact activity bounds mounted children while preserving disclosure and reading positions.
  Delayed Prompt Map seeks lose scroll authority after newer reading intent.
- Source builds stamp their sampled inputs. Source inspection drains started Git children and
  retains unknown identity on failure. Linux direct launch is available when offline inspection
  establishes that no service authority exists.
- The Host discovers managed Pi launchers and symlink aliases, resolves the selected release
  afresh, and loads its SDK and RPC CLI together. A broken managed selection fails explicitly
  rather than falling through to an older global installation.
- Native MCP edits preserve implicit OAuth registration defaults and protected values, and accept
  a UTF-8 BOM. Model metadata honors saved/inherited project-trust refusals.
- Models and MCP share one revision-checked file transaction; cleanup failure cannot strand its
  locks. Six Host state stores share private-file publication while retaining their directory,
  lease and write-order ownership. Frontend reads share one bounded retry loop while retaining
  caller-owned scope and results.
- Production and browser acceptance use the same Host/Runtime path. Browser fixtures supply
  isolated native session files and an offline provider; no simulated production runtime remains.

[[state-ownership]] explains the shared ownership patterns. [[dependency-boundaries]] owns installed
Pi discovery; [[platform-compatibility]] separates portable and native-platform evidence.

## Verification

- **Cross-platform baseline:** the
  [review matrix](https://github.com/XWIlluDelu/pi-inspire/actions/runs/40481436169) at
  `2fe2dc7385e7d275c8f5f2a5fbe9139909aba4ff` passed all seven jobs: Linux quality, macOS and
  Windows platform checks, three installed-package checks and the size report. The
  [original v0.6.5 matrix](https://github.com/XWIlluDelu/pi-inspire/actions/runs/40339358680)
  failed separately; the later pass moved neither that tag nor `main`.
- **Linux:** formatting, lint, unused-code and TypeScript checks, isolated builds, portable and
  launcher checks and the full unit/integration suite pass locally. Local results do not replace
  the cross-platform matrix.
- **Regressions:** long-term tests cover delayed replies, unknown prompt acceptance, worker
  retirement, branch leases, partial persistence, bounded activity, reading intent and terminal
  ownership. The delayed-presentation, mixed-append ordering and managed-Pi resolver repairs each
  carry regressions that fail against the prior implementation, including real-Pi cases.
- **Browser:** Chromium and Firefox cases cover consolidated activity styles, Git file tabs,
  refresh and retained reading positions on mouse and touch layouts. Local WebKit validation is
  blocked by the missing system library `libicudata.so.76`.
- **Installed package:** v0.6.5 passed a local Linux production-only installation check (package
  contents, external Pi startup, readiness and pairing, session recovery, PTY I/O, terminal
  maintenance, and a Host restart that keeps the same terminal), with a clear production
  dependency audit.

Test infrastructure keeps runs independent of the developer's environment: each run gets its own
`XDG_RUNTIME_DIR` (linking only the systemd user-manager entries that worker scopes need), the
launcher lifecycle test builds in a disposable checkout copy instead of the shared `dist/`, and
unit workers use half the cores. Full runs on 32 cores measured the same 41-43s at half the
workers with half the run queue; the default oversubscription made short wait budgets fail in a
different test each run.

## Delivery boundary

The CI repair at `c7f74095` was activated as Inspire 0.6.5 with operator authorization.
The managed-installation rollout reported loaded and installed Pi 1.5.0 through authenticated
bootstrap/update reads while retaining the terminal daemon process. The subsequent development
outcomes are integrated into local `main`. The integration left the annotated release tag and
the running deployment at their existing states.

## Remaining acceptance

- On Android, verify background task outcomes, click-through and offscreen same-Pi prompting,
  plus installed-window status/navigation bars in light and dark modes.
- On iOS/iPadOS, verify Add-to-Home-Screen delivery, permission, badge and click-through.
  [[follow-notifications-2026-10-22]] owns notification device acceptance.
- Native window chrome remains browser/OS-owned; inspect actual installed appearance rather than
  infer it from page theme inputs.
