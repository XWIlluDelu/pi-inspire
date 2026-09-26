---
purpose: Optional Herdr placement and environment capabilities preserve Inspire's Pi workflow and lifecycle.
progress: done
covers:
  - server/herdr-*.ts
  - server/pi-rpc*.ts
  - server/{runtime,runtime-worker-lifecycle,runtime-worker-pool}.ts
  - server/index.ts
  - server/preferences.ts
  - shared/contracts.ts
  - shared/herdr.ts
  - server/local-json-line.ts
  - src/components/*Settings*.tsx
  - tests/web/herdr-settings.test.tsx
  - tests/server/herdr-*.test.ts
  - tests/server/pi-rpc*.test.ts
  - tests/server/runtime.test.ts
---

# Herdr enhancement

## Goal

- Users create and use sessions in the same Inspire GUI, with Herdr as an optional background environment.
- The default direct mode is complete without Herdr. Enabling it adds latent environment capabilities;
  it does not require a new agent feature or workflow.
- Sending, stopping, configuration, restart, pairing, and ordinary project terminals keep their semantics.

## Responsibilities

Pi and user configuration own tools, prompts, extensions, and collaboration under [[pi-integration]].
Inspire owns session identity, writer admission, operation receipts, projection, and GUI controls.
Herdr supplies project workspaces, panes, and their native environment.

Both backends run the installed Pi in RPC mode with stdin/stdout pipes. The Herdr adapter starts an
Inspire bridge in a real pane and forwards the original RPC bytes over private IPC. The existing
Host parser and scheduler remain shared; the bridge owns transport and child cleanup only.
Extensions keep their Pi RPC compatibility requirements.

## Configuration and platform

- `herdrEnabled` defaults off and takes effect on Host restart. Settings distinguishes the saved
  choice, effective state, and availability; live workers keep their current backend.
- Enhanced workers require Linux, `/proc` process-birth evidence, a systemd user manager, and writable
  cgroup v2 scopes with `cgroup.kill`. Missing prerequisites produce a concrete error rather than a
  direct-backend fallback. Other platforms use direct mode.
- Disabled mode makes no Herdr process/API calls during ordinary startup or worker use. Retained
  leases still require recovery, and an explicit Settings availability query may probe Herdr.

## Placement and transport

- Group related workers by project. Create background panes through explicit returned workspace,
  tab, and pane identities, preserving focus. Stop and close only Inspire-owned resources.
- Launch through Herdr's `layout.apply` argv entry. Simulated keystrokes and terminal screen frames
  are unsuitable for ordered RPC transport.
- Bind each control request to the daemon incarnation with socket identity checks before and after
  connection. Herdr uses one request per connection; pane IDs can be reused by a replacement daemon.
- Give workers Inspire's resolved user exports, the same Pi installation/configuration as direct
  mode, and their new pane's genuine environment. Remove inherited worker and pane identities.
- Authenticate each launch over current-user-private IPC. Credentials and launch capabilities stay
  out of command text, terminal history, browser state, and diagnostics. Forwarding preserves RPC
  order, payload limits, and backpressure.

## Worker lifecycle

- Establish ownership before granting permission to start Pi. Each worker uses a standard systemd
  user scope, inherited by Pi's independently grouped Bash processes. Record boot, process-birth,
  and scope path/device/inode identity in the private lease before the grant.
- Ordinary stop first sends cooperative SIGTERM. Forced cleanup opens the verified cgroup directory,
  uses recursive `cgroup.kill`, and waits for `populated=0`, including after Pi or bridge death.
- Runtime retains the actual-stop barrier across explicit stop, unexpected exit, and idle eviction.
  A disconnected bridge or rejected stop cannot release it. Failed new-session creation retains
  its provisional reservation until retirement, even before Pi reports its native session file.
- Recovery processes old leases even when enhancement is disabled. A live previous Host retains
  ownership; otherwise the old worker scope must be empty before a new writer starts. A same-boot
  granted legacy lease without scope evidence remains blocked.
- Host shutdown/restart ends its Pi workers; [[host-lifecycle]] defines Host-only and full restart.
  A shared Herdr server launched by a Linux Host service uses a separate user unit so it survives
  Host replacement. Failure to establish that unit fails startup instead of attaching it to Host.
- After verified Pi retirement, `pane_not_found` ends pane cleanup. `workspace_not_found` invalidates
  cached topology and permits one fresh allocation. Uncertain layout/connection results are not
  retried, and cleanup of an older pane cannot invalidate a newer workspace.

## Status and writer inspection

Reuse the existing conversation, attachment, branch, extension UI, Pending, Stop, and background
session surfaces. Runtime supplies a process-bound session id, run state, and `needsInput`.
The adapter reports `blocked` for input, `working` for active/queued work, and `idle` otherwise;
unchanged reports are coalesced.

Herdr receives the custom `inspire-rpc` agent/source and a display-only session-id token. Reporting
stops on retirement, while metadata remains until verified termination and owned-pane closure.
This RPC worker is distinct from Herdr's resumable native Pi TUI.

Before opening an existing file for writing, inspect Herdr's current native Pi path/id and sibling
Inspire session-id tokens, then check candidate panes for a live foreground Pi process. Historical
metadata alone cannot block admission. This is a pre-launch check of Herdr-reported writers;
other applications' unreported or later launches remain outside its authority.

## Checks and evidence

- Compare real-Pi startup, state, persistence, events, cancellation, and shutdown through both
  transports using isolated fixtures. Verify explicit pane selection and no-focus creation with a
  disposable Herdr server.
- Exercise launch/stream failure, Host/bridge/Pi death, detached Bash cleanup, and recovery with the
  enhancement disabled. Confirm pending and rejected retirement retain writer exclusion.
- Check stale topology, incarnation changes, writer inspection, coalesced status, and disabled-mode
  independence. Retain ordinary terminal and restart regressions.
- Measure bridge overhead separately from model work, with the environment and sample scope recorded.

Initial transport and environment evidence, including Herdr 0.9.1 / protocol 22:
[[follow-herdr-enhancement-2026-09-25]]. Lifecycle/topology checks:
[[follow-herdr-review-boundaries-2026-09-25]]. Systemd-scope and real Pi/Bash crash checks:
[[follow-deep-review-repairs-2026-09-26]]. Herdr's [socket API](https://herdr.dev/docs/socket-api/)
defines the argv layout and metadata interfaces.
