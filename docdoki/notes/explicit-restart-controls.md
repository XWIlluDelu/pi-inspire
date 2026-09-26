---
purpose: Explain explicit restart ownership, preparation safety, and bounded verification of CLI and Settings controls.
---

# Explicit restart controls

## Contract and implementation

[[host-lifecycle]] keeps ordinary and scheduled restart Host-only. Full restart is explicit (`inspire
restart --all` or Settings → Updates → Restart all), requires installed Linux services, and ends
terminal processes. Confirmations remain concise, with no always-visible or command-palette control.

`inspire.mjs` runs dependency/client-build preparation and `server/restart-preflight.ts` imports
runtime modules plus the external Pi SDK before any stop. This probe does not open sessions, run
extensions, bind a Host, or attach to a terminal. Browser preparation inherits the running Host's
environment; bounded subprocess diagnostics expose preparation failures without stopping it.

`HostRestartController` owns one active intent and up to 32 retained identities per Host incarnation.
Preparation precedes a fresh runtime idle reservation. `requestBrowserRestart` rechecks exact unit
and invocation ownership before committing the existing non-expiring drain. Systemd receives a
single full-restart transaction, with Host ordered after terminal startup. There is no full-to-Host-only
fallback and no connection-service restart. Unknown submission retains the drain; it is not a refusal.

When an idle-only page restart is rejected for active or in-flight Pi work, Settings offers a
separate confirmed **Stop work and restart** under the rejected scope. The new operation identity
carries `interruptWork: true`; a retry cannot upgrade an idle-only identity, and the server rejects
same-identity permission changes. The runtime lease bypasses workload idle checks (run/dialog/Pending,
active operations and maintenance counters), retaining preflight, exclusive restart lease and final
service-owner checks.
The existing Host close path stops all worker process groups on successful Host replacement;
Host-only leaves project terminals independent, while all-services restart ends terminal processes.
The prior refusal is labelled as a last-attempt result rather than a live busy diagnosis.

The browser persists delivery identity before POST, restores it on reload, rechecks read-only, and
retries only the same identity explicitly. A new Host retires that old identity without claiming that
all terminal work restarted successfully. Current authoritative preparation outranks old reconnection
notices. Concurrent status observers share an in-flight service inspection.

## Evidence (2026-09-09)

- Node **22.19.0**, npm **10.9.2**: `npm test` — 150 files, 1500 passed, 2 skipped.
- `npm run test:launcher` — 9 passed, 1 platform skip; actual isolated source-launch build,
  preparation and Host lifecycle, plus persistence of newly created terminal PTYs. The pre-push
  Node 22.19.0/npm 10.9.2 rerun exposed the service-delegation test's five-second default as too
  short for cold preparation. It now has a local 60-second integration-test allowance with all
  assertions intact; rerunning the serial suite with the build stamp removed passed 9/9, with
  the same platform skip (`/tmp/inspire-prepush-launcher.log`).
- `tests/restart-launcher.test.ts` uses a temporary packaged-runtime layout and fake systemctl:
  failed preparation submits no stop/restart for either scope; success prepares before one
  correctly scoped transaction; unknown flags refuse before inspecting services.
- `tests/server/host-restart*.test.ts` covers bounded diagnostic subprocess failure, authentication,
  foreign Origin, stale Host/scope identities, deduplication/late observers, busy-work rejection,
  known non-issuance release, and ambiguous submission retaining drain.
- `tests/web/host-restart*.test.{ts,tsx}` covers concise confirmation/cancel/scope, current state
  over historical notice, unavailable controls, persisted uncertain identities, explicit retry,
  Host replacement, malformed storage and storage-write failure.
- `tests/deploy/systemd-control.test.mjs` verifies exact invocation, final commit ordering,
  the one-transaction full restart and old maintenance behavior with synthetic systemctl.
- Format, lint, TypeScript and unused-code checks passed. `scripts/build-release.mjs` and
  `npm run release:verify` passed with production-only installation, external Pi 0.85.1, packaged
  preparation subprocess, real isolated Pi startup, mock health, PTY and fork worker checks.
- Playwright CLI drove the isolated browser-test Host at 1280×900/light and 390×844/dark.
  Verified confirmation bounds, Cancel focus, Escape/focus restoration to Settings, both scopes,
  cancellation sending nothing, lost POST reply followed by authoritative preparation, Settings
  closure/reload without resend, preparation rejection and new-Host observation. Exactly two
  intentional POSTs (one per scope); axe found zero violations within either full confirmation.
  Reviewed screenshots: `output/playwright/restart-{host,all}-{desktop,narrow}.png` and
  `output/playwright/restart-rejected-narrow.png`. Local reproduction script:
  `output/playwright/restart-flow.js` (CLI run-code, fixture API interception, service workers blocked).

## Focused interruption evidence (2026-09-25)

- TypeScript (`tsc -b`) and 38 selected Host restart, restart API, scheduled-maintenance,
  runtime lease/close, and Web restart tests passed. The selected runtime maintenance block covers
  active queued Pi work and a genuinely pending manual `compact` RPC: idle-only reservation refuses
  them; the explicit lease commits and fences new work; normal close stops the worker and settles its
  RPC. A second restart lease remains unavailable even with the grant. Preparation failure never
  requests a lease or restart.
- Narrow (390×844) headless Chromium rendered the actual Settings confirmation with the real CSS
  using an isolated Vite component fixture; screenshot:
  `output/playwright/restart-stop-work-narrow.png`. The dialog fits inside the 390px viewport and
  names Pi work, Pending input, terminal processes, and scope. No installed service was restarted.

## Startup retirement evidence (2026-09-26)

Failed startup previously left `startupPhase` at `starting`; a response-bearing startup dialog
also retained an already-settled `startupStop` promise. Both were counted as in-flight work after
Pi had stopped. Shared retirement now ends the startup phase only after actual stop succeeds.
Startup UI rejection uses the existing error latch to interrupt the handshake once, without a
second retained stop promise. The original error and an unconfirmed actual-stop fence are preserved.

- Runtime/controller regressions cover startup error, transport exit, and startup-dialog failure:
  ordinary restart refuses while retirement is pending, then a fresh ordinary request succeeds.
  The old rejected request remains immutable. Failed retirement still blocks restart and replacement.
- `tests/server/pi-startup-retirement.integration.test.ts` runs real Pi with isolated configuration
  and no model calls: an idle live worker, missing extension, and startup dialog all reach valid idle
  restart admission once work/retirement has settled. Existing new-session, branching, RPC lifecycle,
  explicit-interruption, maintenance-lease, restart API and Web restart regressions also passed.
- 249 tests across 11 selected files, server TypeScript, and targeted Biome checks passed. These
  checks used an isolated worktree; service submission in controller tests was synthetic, and no
  installed service was restarted.

## Limits

No daily service was stopped or restarted, and no real conversation/terminal body was inspected.
Browser restart outcomes were intercepted synthetic API responses; installed service dispatch was
verified with fake systemctl, not a live remote restart. Local execution was Linux; Windows/macOS
page/full restart is deliberately unavailable, not claimed tested here.

Preflight is not a full boot rehearsal, immutable deployment, or rollback mechanism. Source can
change, CLI/service environments can differ, and ports or runtime startup can fail after preparation.
The CLI verifies systemd's readiness hook after restart; the browser observes a new Host rather than
asserting end-to-end tunnel or full-terminal success. A submitted operation that cannot be established
as unissued retains its drain and requires operator service recovery.
