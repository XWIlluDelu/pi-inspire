---
scope:
  - server/{app,index,pi-rpc,pi-rpc-stop,runtime,runtime-slot,runtime-worker-lifecycle,maintenance-restart}.ts
  - server/terminal-*.ts
  - shared/{contracts,terminal-contracts}.ts
  - src/api.ts
  - src/controllers/{composer,terminal-operation}-controller.ts
  - src/components/{TerminalPane,TerminalView,AppTopbar,ContextPane}.tsx
  - src/terminal-focus.ts
  - src/styles/terminal.css
  - deploy/systemd/{control,idle-maintenance-restart}.mjs
  - scripts/start-browser-test-host.mjs
  - package.json
  - tests/
---

# Align operation lifecycles

## Objective

Repair all five confirmed lifecycle-ownership defects, not merely enlarge hard-coded waits.
Contracts: [[composer]], [[pi-integration]], [[session-transport]], [[session-branches]], [[terminal]],
[[host-lifecycle]]. Reusable rationale, checks and limits: [[operation-lifecycle-ownership]].

## Final state

Completed 2026-09-08:

- Pi-owned mutations have no generic completion deadline. Bounded prompt HTTP observations share
  one retained operation; uncertainty keeps its ID. Explicit Stop bypasses blocked preflight, and
  actual worker retirement gates replacement/recovery.
- Independent and in-process terminal owners share bounded mutation receipts and epoch fencing.
  Browser unknown identities survive project changes and reload; malformed storage blocks writes.
  Recovery rows, lazy-panel ARIA relations, and activation-scoped focus were verified in Chromium.
- Maintenance restart separates expiring prepare from exclusive committed drain; ambiguous issued
  commands cannot reopen admission. Ordinary Host startup also cannot replace an independently
  running incompatible terminal daemon or terminate its PTYs to upgrade the protocol.

## Verification

Final `npm run ci` passed using Node **22.19.0** / npm **10.9.2**:

- Formatting, lint, typecheck, unused-code checks, and production web build passed.
- **1,464 Vitest tests passed, three skipped**; **17 portable checks passed**.
- **36 Chromium tests passed**, including lost terminal receipt → reload → keyboard retry at
  desktop/light and narrow/dark sizes, reduced motion, and terminal-pane accessibility checks.
- Real Pi **0.85.1** completed the **35-second** synthetic preflight-compaction regression on the same
  worker, and extension confirmation/explicit Stop passed through the actual API/Host/runtime.

No implementation obligations remain in this stage. Evidence is Linux-local with injected Windows
termination tests, not a native Windows/macOS run or remote-provider benchmark. Real conversations
and compaction summaries were not read; daily-use services were not restarted.

## Deployment boundary

No commit, push, release, tag movement, or deployment was included. Pi changes require loading the
new Host code. The terminal receipt protocol is version 2; a version-1 daemon must be explicitly
restarted after terminal work is finished. The Host reports that requirement rather than silently
killing independent processes. An ambiguous issued maintenance restart remains drained until
owner/operator recovery establishes that the prior runner and restart job can no longer execute.
