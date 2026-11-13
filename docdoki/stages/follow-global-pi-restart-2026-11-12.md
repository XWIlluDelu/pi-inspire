---
scope:
  - inspire.mjs
  - server/{host-restart*,pi-processes.*,app.ts,index.ts}
  - shared/host-restart.ts
  - src/{components/HostRestartSettings.tsx,controllers/host-restart-controller.ts}
  - tests/{server,web}/*restart*.{ts,tsx}
  - tests/portable/pi-processes.test.mjs
  - tests/restart-launcher.test.ts
  - docs/host.md
---

# Restart all Pi sessions

## Objective

Implement the user-selected **Restart all** scope in [[host-lifecycle]]: close current-user Pi
regardless of owner, including Herdr Pi only when enhancement is currently active, then restart
Inspire and the installed project-terminal service.

## Current state

- Implemented Linux process discovery/termination, the confirmed browser action, and CLI scopes.
  The running Host fixes Herdr inclusion; saved next-start preferences do not change the target.
- Existing API scope `all` retains terminal-service-only semantics for older browser generations.
  The new UI uses `all-pi` with explicit interruption permission. CLI `--terminals` retains the
  previous service-only behavior; `--all` uses the new Pi reset.
- Focused checks passed: 102 Vitest cases for admission, API, signed local control, client, settings,
  mode selection, launcher ordering/failure and systemd controls; 36 portable cases for launcher
  handoff, process cleanup and caller ancestry. Native cleanup tests enumerate only disposable
  fixtures. Three Chromium restart cases cover confirmation/mode and ordinary busy-restart recovery.
- Typecheck, Knip, frontend build and compiled release build passed. Signed local control confirms
  the new effective-mode response. Service inspection confirms restart availability.
- Live global shutdown has not been invoked: it would end the implementation session and other
  user sessions. Destructive behavior is covered with injected adapters and owned disposable Pi.
