---
scope:
  - inspire.mjs
  - deploy/systemd/**
  - server/{app,index,terminal-daemon-launcher}.ts
  - server/user-environment.{mjs,d.mts}
  - scripts/{build-release,verify-release-package}.mjs
  - tests/{launcher,restart-launcher,user-environment-launcher}.test.ts
  - tests/server/{app,pi-rpc,terminal-daemon-environment}.test.ts
  - tests/portable/user-environment.test.mjs
  - package.json
  - README.md
---

# Reuse the user's execution environment

## Objective

Implement the user's approved environment reuse: inherit direct-launch exports, acquire normal
shell exports for services, and prevent Inspire-only settings from altering Pi or project tools.

## Final state

The requested project changes are complete. [[host-lifecycle]], [[pi-integration]], and [[terminal]]
hold the contract; [[user-execution-environment]] records rationale, checks, limits, and deployment.

- Launcher discovery resolves service exports before dependency or runtime loading, with explicit
  overrides, bounded private export transport, visible failure, and no recursive discovery.
- Host and terminal startup no longer force NODE_ENV. Express configures its own HTTP mode, and
  independent terminal lifetime does not depend on a user's NODE_ENV=test.
- Transient terminal services receive the provided exports without values in command arguments or
  stale service identities. The compiled release copies and requires the new support module.
- Verification: 9 portable environment tests; 91 targeted runtime/launcher/service tests; 9 serial
  launcher tests (one platform-specific case skipped); type checking; scoped lint/format;
  import-boundary and unused-file checks; compiled release build/import; DocDoki privacy check.
- Local shell discovery and an isolated short-lived systemd transfer were exercised. No full
  publication verifier or non-Linux runtime verification was claimed.
- Existing terminal-controls and package-lock work remains in place. The running services, shell
  configuration, external Pi installation, and workaround symlinks were not changed.

## Deployment

This stream is closed at the requested project-modification stage. Applying the change to existing
services remains an explicit operational step documented in README and [[user-execution-environment]]:
reinstall units, then schedule a full restart when ending terminal processes is acceptable. Do not
remove workaround symlinks before validating the new runtime's command lookup. No active code gap
or additional design decision remains from this work.
