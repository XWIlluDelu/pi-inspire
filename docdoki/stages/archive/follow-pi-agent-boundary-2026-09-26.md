---
scope:
  - docdoki/northstar.md
  - docdoki/spec_abstract.md
  - docdoki/specs/pi-integration.md
  - docdoki/specs/herdr-enhancement.md
  - server/runtime*.ts
  - server/extensions/**
  - server/session-catalog.ts
  - server/app.ts
  - package*.json
  - tests/server/runtime*.test.ts
  - tests/server/session-catalog.test.ts
  - tests/server/herdr-rpc.test.ts
---

# Pi agent ownership and transparent environment enhancement

## Outcome

The implementation follows the combined product and quality boundary in the
Northstar, [[pi-integration]], and [[herdr-enhancement]]:

- Pi and user configuration own model tools, prompts, extensions, and agent
  behavior. Inspire provides GUI controls and optional environment adaptation,
  not a second agent platform or a prescribed collaboration workflow.
- Herdr supplies genuine placement and environment. Latent capability is
  sufficient; it does not require an extra model tool or visible workflow.
- Runtime supplies only its internal branch-navigation command for an explicit
  GUI action. This extension registers no model tools and no prompt hooks.
  Ordinary session discovery uses Pi's catalog, without a parallel collaborator
  catalog, private messaging service, collaboration receipts, or direct schema dependency.
- The same worker factory, user configuration, and prompt path serve ordinary
  new/resumed sessions. Actual-stop fencing, topology recovery, canonical state
  projection, detached-tool cleanup, and existing restart semantics remain.
- Performance, reliability, clarity, maintainability, and narrow module boundaries
  constrain implementation choices. Small patch size is not a substitute for a
  clean final structure; speculative abstractions and redundant fallbacks are not goals.

## Verification

- 330 tests passed across 13 files, covering Runtime, ordinary catalog/API routes,
  branching/projection, the installed-Pi branch bridge, RPC, and Herdr client,
  transport, observer, enhancement, and status boundaries.
- Two focused startup cases assert the exact additional argv/environment for new
  and resumed workers and unchanged plain user prompt delivery. Existing branch
  extension tests cover its non-model command surface.
- Type checking, the release server build, targeted Biome, unused-code checking,
  diff checks, and DocDoki privacy checking passed. The cleaned build contains
  only the internal GUI extension and no direct collaboration-schema dependency.
- This verification did not repeat a benchmark, full package installation,
  browser inspection, or real Herdr daemon smoke run. The latter's original
  evidence remains in [[follow-herdr-enhancement-2026-09-25]].

No deployment or service restart is part of this work. Already-running Pi workers
retain their loaded configuration until the ordinary replacement/restart path.
