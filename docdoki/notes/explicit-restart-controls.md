---
purpose: Explain restart admission, operation identity, and source-handoff failure modes, with verification evidence.
---

# Explicit restart controls

## Scope and preparation

The contract is in [[host-lifecycle]]. Host-only restart replaces Pi workers and preserves project
terminals. Restart all also ends terminal processes and requires this installation's Linux systemd
Host and terminal services. Scheduled maintenance remains Host-only and idle-gated.

`inspire.mjs` prepares dependencies and the client build; `server/restart-preflight.ts` imports the
next runtime and external Pi SDK before the current Host stops. Browser preparation uses the
running Host's environment. A preparation failure leaves it running.

## Restart admission

`HostRestartController` owns one active request and retains up to 32 operation identities for the
Host incarnation. Each identity fixes its scope and interruption permission. The browser stores
that identity before POST, observes it through GET, and uses it for explicit retry.

After preparation, an ordinary page request acquires a fresh idle restart lease. An idle live Pi
is allowed; runs, dialogs, Pending input, startup, unfinished operations, and unconfirmed stops
block admission. A busy refusal offers **Stop work and restart**. Confirmation creates a new
operation with `interruptWork: true`, bypassing workload checks while retaining preparation,
exclusive lease ownership, and service checks. Retrying the refused operation cannot add permission.
The UI labels a refusal as the last attempt because the workload may have changed since then.

`requestBrowserRestart` rechecks the exact systemd unit and invocation before committing the drain
and submitting the restart. Restart all uses one transaction, with Host ordered after terminal
readiness. A confirmed failure to issue releases admission; uncertain submission keeps the drain
for operator recovery. [[operation-lifecycle-ownership]] explains the owner-bound maintenance lease.
The CLI checks service readiness; the browser reports reconnection to a new Host.

## Failed-startup cleanup

A failed startup previously left `startupPhase = "starting"`; a startup dialog could also retain
an already-settled `startupStop` promise. Both looked like unfinished work after Pi had stopped.

`RuntimeWorkerLifecycle.stop` now returns startup to idle only after confirmed retirement. The
startup error latch interrupts a rejected handshake once, without a second stop promise. The
original failure remains available, while a pending or rejected stop continues to block ordinary
restart and replacement. A fresh request can succeed after cleanup; the old refusal stays unchanged.

## Source-checkout handoff

A running source Host can load extension entrypoints when it starts a later worker. Removing or
renaming a referenced file can therefore break new sessions before the Host restarts. Preserve
those paths through the handoff, or prepare the new source in a separate directory. Preflight
validates the files it sees; it does not freeze a mutable checkout for the running Host.

## Regression coverage

| Area | Evidence |
| --- | --- |
| CLI preparation and scope | `tests/restart-launcher.test.ts` checks failed preparation, scoped systemd submission, and flag validation in a packaged-runtime fixture. |
| Host admission and identity | `tests/server/host-restart*.test.ts` covers authentication, scope/permission mismatch, retained receipts, busy rejection, non-issuance, and unknown submission. |
| Browser recovery | `tests/web/host-restart*.test.{ts,tsx}` covers confirmation, storage, read-only recheck, retry identity, and Host replacement. |
| Service ownership | `tests/deploy/systemd-control.test.mjs` checks exact invocation, final commit ordering, and the full-restart transaction with synthetic systemctl. |
| Startup retirement | `tests/server/runtime.test.ts` covers pending and rejected stops; `tests/server/pi-startup-retirement.integration.test.ts` uses real Pi with temporary configuration for idle, missing-extension, and startup-dialog cases. |

## Recorded verification

- **2026-09-09:** Node 22.19.0/npm 10.9.2; 1,500 default tests passed with two skips, plus
  nine launcher tests and one platform skip. Release verification exercised a production-only
  install with external Pi 0.85.1, preparation, startup, PTYs, and fork workers. Chromium at
  1280×900/light and 390×844/dark checked confirmations, focus, lost-response observation, and
  recovery with intercepted restart responses; both confirmation dialogs passed axe checks.
- **2026-09-25:** 38 targeted interruption/restart tests and TypeScript passed. Runtime cases
  covered queued work and pending manual compaction, exclusive leases, and worker shutdown.
  A 390px Chromium fixture checked the interruption confirmation and scope copy.
- **2026-09-26:** 249 tests across 11 files, server TypeScript, and targeted Biome passed.
  The real-Pi cases verified ordinary restart admission after failed startup. Controller service
  submission used a fixture; live systemd dispatch was not part of these checks.
