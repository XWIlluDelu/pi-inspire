---
scope:
  - inspire.mjs
  - deploy/systemd/control.mjs
  - server/{host-restart,host-restart-systemd,restart-preflight}.ts
  - server/{app,index,terminal-service,terminal-daemon-launcher}.ts
  - shared/host-restart.ts
  - src/api.ts
  - src/controllers/host-restart-controller.ts
  - src/components/{HostRestartSettings,Settings}.tsx
  - tests/{server,web}/host-restart*.{ts,tsx}
  - tests/restart-launcher.test.ts
  - scripts/verify-release-package.mjs
---

# Explicit restart controls

## Outcome

Completed the approved CLI Host-only/full scopes and Settings → Updates controls with concise
confirmation and preparation-before-stop protection. [[host-lifecycle]] and [[terminal]] hold the
contract; [[explicit-restart-controls]] holds implementation rationale, verification and limits.

Node 22 unit/launcher suites, static checks, compiled production-package verification and isolated
Playwright desktop/narrow checks passed. No daily service was restarted and no live conversation
or terminal output was read. Runtime activation remains an operator restart; preflight is not a
startup-success or automatic-rollback guarantee.
