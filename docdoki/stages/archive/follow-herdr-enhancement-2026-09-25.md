---
scope:
  - docdoki/specs/herdr-enhancement.md
  - server/herdr-*.ts
  - server/pi-rpc*.ts
  - server/runtime*.ts
  - server/app.ts
  - server/index.ts
  - server/preferences.ts
  - shared/contracts.ts
  - shared/herdr.ts
  - src/components/*Settings*.tsx
  - tests/server/**
  - tests/web/herdr-settings.test.tsx
---

# Optional Herdr enhancement — completed

## Outcome

Implemented the initial Linux delivery of [[herdr-enhancement]]. Inspire remains the
graphical entry point. The default-off enhancement supplies genuine Herdr placement and
environment through a private byte transport, without owning Pi's tools, prompts, or
collaboration policy. Session identity, Pi protocol, operation scheduling, restart, and
ordinary project terminals retain their existing authority.

The preceding busy-input repairs were committed separately as `2fa787e` and `4e4f7f0`.
Verification did not deploy, restart installed services, or operate on the user's default
Herdr server.

## Implementation decisions

- `PiRpcProcess` retains one parser/request implementation. Direct child pipes and
  `HerdrRpcTransport` implement its transport boundary; both preserve actual-exit fencing.
- The enhanced bridge starts through Herdr `layout.apply` argv, with no-focus, explicitly
  owned project workspaces/tabs. It receives credentials over private IPC, never pane command text.
- Private leases record boot/process-group birth ownership before permission to start Pi.
  Recovery also runs when enhancement is disabled. Socket loss cannot release writer authority.
- Herdr control accepts one request per connection. Pre/post-connect socket identity checks bind
  each connected FD to one daemon incarnation; stale pane IDs cannot close a successor's panes.
- A custom `inspire-rpc` status and display-only session-id token avoid advertising an RPC worker
  as a native Pi TUI. Exact session metadata plus live foreground process evidence detects known
  native Pi and sibling Inspire writers; it is not a universal cross-application lock.
- Settings saves `herdrEnabled`, distinguishes saved from effective state, and links pending
  changes to existing restart controls without initiating a restart or migrating live work.

## Verification

- Relevant original checks passed for transport/ownership, Herdr client, bridge/observer/factory/
  status, Runtime, catalog, preferences, restart, and Settings. Type checking, touched-source
  Biome, unused-code checking, diff checks, and DocDoki privacy checking also passed.
- A production-only package install passed `release:verify`: required files/notices/assets,
  portable CLI, mock lifecycle, terminal PTY, real Pi startup, and fork-worker checks.
- Disposable named Herdr 0.9.1 / Pi 0.87.1 instances with fresh HOME and no shell setup files
  exercised the production factory/transport: state, Bash, genuine pane/session environment,
  child PGID, stop, empty leases, and disappearance of the owned Pi process and pane.
- Real crash recovery killed only a fixture Host while suspending its bridge watchdog. A new,
  disabled enhancement instance recovered the verified old group and lease before direct Pi
  startup. Separately, known native Pi TUI and sibling RPC writers produced 409 until stopped.
- Desktop and 390px Chromium checks used an isolated mock Host with mocked Herdr availability:
  default-off/unavailable, save-on, pending restart notice, and the existing restart anchor.
  The page did not overflow or issue a restart mutation. Screenshots are local artifacts under
  `output/playwright/herdr-settings-{desktop,mobile}.png`.
- A small 25-call warmed `get_state` sample measured median direct/bridge round trips of
  0.020/0.033 ms. One startup sample was 113/486 ms with the Herdr daemon already running.
  These are smoke measurements, not throughput, stable percentile, or all-platform claims.

## Limits and rejected approaches

- Enhanced workers require Linux; other platforms retain normal direct RPC. Other-platform
  enhancement and native TUI/GUI co-attachment are not delivered.
- No real external model, installed-systemd-service restart, or arbitrary unreported external Pi
  writer was exercised. Shared-server startup isolation under systemd is covered at the CLI boundary.
- Terminal frames are not raw RPC. `pane run` types into a shell and can lose input during shell
  initialization. A persistent multi-request Herdr control socket fails with EPIPE in 0.9.1.
- Environment-only `HERDR_PANE_ID` injection fabricates placement. A long-lived independent Pi
  session daemon would change restart semantics and solve a requirement the user did not request.

The implementation objective is complete; deployment and any additional platform scope require
separate work rather than keeping this implementation stage open.
