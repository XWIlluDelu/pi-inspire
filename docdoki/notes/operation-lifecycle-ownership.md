---
purpose: Explain observation deadlines, operation identity, worker retirement, and restart authority, with regression evidence.
---

# Operation lifecycle ownership

## Principle

The execution owner decides whether work was accepted, completed, or stopped. A caller's deadline
ends its observation, not the operation. Retry and restart decisions require the current operation
identity or lease. Contracts: [[composer]], [[pi-integration]], [[session-branches]], [[terminal]],
and [[host-lifecycle]].

## Pi and prompt observation

`server/pi-rpc.ts` leaves Pi-owned mutations unbounded: preflight, compaction, export, and branch
hooks may wait for Pi or a user. Read-only RPCs default to 30 seconds. A timed-out observer retains
its exact id/command for a late response; the 256-request admission budget includes those retired
identities. A protocol or stream failure instead retires the worker.

`server/app.ts` admits a prompt once and returns a pending receipt after 20 seconds. `src/api.ts`
observes the same Host/operation through authenticated GET, with 30 seconds per HTTP observation.
Neither reconnect nor result retirement replays the payload; retired results leave identity
tombstones.

A definitive retained-operation refusal requires matching `X-Inspire-Authority`,
`X-Inspire-Prompt-Operation`, and rejected `X-Inspire-Prompt-Outcome` headers. Authentication,
middleware, and lookup failures lack that evidence, so the browser keeps the original delivery
identity. Confirmed Pi acceptance also survives consumed-upload cleanup failure.

Runtime keeps preflight input queued until Pi lifecycle evidence or an owned idle-state read settles
it, including hooks that finish without starting an agent. Stop can bypass the persistence FIFO to
retire a worker blocked in preflight; the interrupted prompt remains acceptance-unknown. The private
branch handler's RPC completion fences its matching result, so a missing result fails at completion.

## Worker retirement

`PiRpcProcess` shares one stop attempt across callers. The direct helper in `server/pi-rpc-stop.ts`
waits for leader exit or proven spawn failure, plus completion of process-tree signaling. Herdr
also verifies the worker scope is empty, including independently grouped Bash processes
([[herdr-enhancement]]).

`RuntimeWorkerLifecycle.stop` removes the worker from service synchronously and retains
`slot.stopping` until confirmed retirement. Pending or rejected termination blocks replacement and
recovery writes. Signals and watchdogs cannot release that barrier. Completed startup cleanup uses
the same barrier; [[explicit-restart-controls]] explains the stale-startup-state repair.

A protocol-write failure notifies Runtime on either stop outcome. `stopForProtocolFailure` handles
both outcomes on its notification branch while returning the original stop promise. Handling only
success left a detached rejection that could terminate the Host even when the caller handled both
the request error and the stop error.

## Terminal mutations

`server/terminal-operation-receipts.ts` owns immutable mutation identities across IPC correlation
IDs. Same-intent retries join work or return its result; parameter changes are refused. Bounded
retention uses admission epochs to reject forgotten identities. A replacement daemon has a new
epoch, so the client must resolve uncertainty rather than replay an old mutation there.

The browser saves unresolved identities in tab-session storage before dispatch and retains them
across project changes and reload. Invalid stored intent blocks dispatch. Identified requests use
the receipt protocol; legacy HTTP callers without identities still create one intent per request.
The in-process terminal manager uses the same receipt and mutation implementation. Read,
attachment, and input streams remain separate from control-mutation receipts.

Private daemon protocol **2** supplies these receipts. An existing version-1 daemon stays running
with its PTYs, but is unavailable to the new Host. Upgrading it requires an explicit terminal-service
restart after finishing terminal work. `terminal-daemon-launcher.test.ts` checks that a failed probe
leaves the existing daemon alone.

Unconfirmed operations appear in a bounded recovery list. Recheck disables only its own button.
Late xterm readiness, font, replay, or writer-state callbacks cannot take focus from recovery;
`terminal-focus.ts` permits one guarded focus frame for explicit or neutral activation. Take control
remains a separate user gesture.

## Maintenance restart

`RuntimeController.reserveMaintenanceRestart` grants an expiring preparation lease;
`commitMaintenanceRestart` consumes that exact, current lease and keeps admission closed without
expiry. `deploy/systemd/idle-maintenance-restart.mjs` inspects systemd before committing, then issues
one restart. `MaintenanceRestartController` limits scheduled preparation to changed installed
identities and idle work.

Release belongs to the lease owner and invalidates reordered commits. It is safe before issuance
or after a proven failure to spawn systemctl. An ambiguous submitted command keeps the drain.
Operator recovery must first establish that neither the old runner nor a submitted systemd job can
still restart the Host.

## Regression coverage

| Area | Evidence |
| --- | --- |
| RPC and retirement | `tests/server/pi-rpc-ownership.test.ts`: long waits, late responses, bounded admission, stream validation, shared stop fencing, delayed signaling, failed spawn, and rejected-stop notification. |
| Runtime ownership | `tests/server/runtime.test.ts`: preflight cancellation, branch results, failed-stop fencing, idle hook settlement, and accepted input after cleanup failure. |
| Prompt observation | `tests/{server/app,web/api,web/composer-controller}.test.ts`: one dispatch, retained identities, disconnected observers, and observation errors versus operation refusal. |
| Terminal identity | `tests/{server,web}/terminal-operations.test.ts`, `terminal-inprocess-operations.test.ts`, and `terminal-operation-restore.test.ts`: lost replies, concurrent retries, payload/epoch checks, and stored-intent validation. |
| Restart leases | `tests/server/maintenance-restart.test.ts`, `tests/deploy/idle-maintenance-restart.test.mjs`, and `tests/launcher.test.ts`: expiry, exclusive commit, reordered release, non-issuance, and uncertain submission. |

## Real-Pi and browser evidence

`tests/server/pi-operation-lifecycle.integration.test.ts` passed on Node 22.19.0 / Pi 0.85.1 using
the authenticated Host, browser API, real Pi CLI, temporary configuration, and a loopback synthetic
provider. Pi selects pre-prompt compaction whose fixture hook waits 35 seconds, crossing the real
20-second Host and 30-second browser observation windows. The test checks one POST, same-identity
GETs, the same worker PID, one persisted compaction, and two intended turns. A second case answers
an extension dialog, then stops an unanswered one while retaining its unknown delivery outcome.

Browser recovery tests lose a committed terminal-create response, reload, and retry the same
identity. The catalog still contains one terminal; recovery focus and layout hold at 1280×900/light
and 390×844/dark.

## Recorded verification

- **2026-09-08, Linux / Node 22.19.0 / npm 10.9.2:** `npm run ci` passed: 1,464 Vitest cases
  with three skips, 17 portable checks, 36 Chromium cases, and format/lint/type/build/unused-code
  checks. Windows signaling used injected process events in this run.
- **2026-09-26:** 150 selected RPC, Herdr transport, and Runtime tests, server TypeScript, and
  targeted Biome passed. The new rejected-stop case reproduced the old missing notification and
  unhandled rejection, then passed after repair. An independent Node process with a synthetic
  transport changed from exit code 1 to normal completion when both response delivery and stopping
  failed.

The original implementation record is [[align-operation-lifecycles]].
