---
purpose: Explain and verify the distinction between observation deadlines, execution outcomes, mutation identity, confirmed writer retirement, and maintenance-restart authority.
---

# Operation lifecycle ownership

## Principle

A layer's inability to observe work does not prove what the owner did. In particular:

- No timely receipt does not mean no execution or a dead worker.
- An HTTP refusal can reject the observation rather than the original operation.
- A stop signal, escalation deadline, or expired wait does not confirm process exit.
- Once-valid permission does not authorize a later action after ownership changes.

The corresponding decisions belong to the execution owner and its operation identity, not a
transport timer, command spelling, callback completion, or stale lease. This extends
[[state-authority-review]] from presentation to decisions that can stop, duplicate, or interrupt
work. Contracts are in [[composer]], [[pi-integration]], [[session-branches]], [[terminal]], and
[[host-lifecycle]].

## Repairs

### Pi and prompt observation

`server/pi-rpc.ts` no longer gives Pi-owned mutations a generic completion deadline. Prompt
preflight can include auto-compaction, input/before-agent hooks, and extension interaction;
standalone compaction, export, and branch hooks can also legitimately take time. Read-only RPCs
retain a bounded observation deadline. Timed-out observers leave exact id/command tombstones for
late responses; the bounded 256-request admission budget includes those tombstones instead of
evicting them. Protocol/stream failure remains distinct and does retire a worker.

`server/app.ts` admits a prompt once and returns a pending receipt after its 20-second HTTP
observation window. `src/api.ts` re-observes that same Host/operation by authenticated GET, with a
30-second limit per HTTP observation and no replayed text/attachments. Transport retirement only
aborts observation. Host result retirement leaves an identity tombstone, not permission to run again.

Only a matching `X-Inspire-Authority`, `X-Inspire-Prompt-Operation`, and rejected
`X-Inspire-Prompt-Outcome` identify a retained operation's definitive refusal. Auth, middleware,
missing/retired lookup, and other observation errors do not acquire that proof. Explicit unknown
outcomes retain the draft's ID even when authored by the same Host. Confirmed Pi acceptance also
survives failure of best-effort consumed-upload cleanup.

`server/runtime.ts` keeps a preflight prompt queued until actual lifecycle evidence arrives and
retires that queued state when a non-agent extension command completes. Stop during preflight
bypasses the persistence FIFO and can stop its owning worker even if Pi's ordinary abort cannot
interrupt a waiting hook. Such interruption remains acceptance-unknown. Private branch-handler RPC
completion fences its matching result, so missing results fail immediately after completion rather
than requiring an arbitrary branch timer. Diagnostic phases are coarse metadata, not payloads or
execution authority.

### Confirmed worker retirement

`server/pi-rpc-stop.ts` owns one shared termination promise. It requires observed leader exit (or
proven failure to spawn) and completed process-tree signaling before resolving. Slow signaling,
escalation, and watchdog expiry do not fabricate `worker_stopped`. `server/runtime-worker-lifecycle.ts`
retains even a rejected stop barrier, so replacement and recovery cannot acquire a writer before
termination is established. Concurrent Stop calls join the same retirement.

### Terminal mutation identity

`server/terminal-operation-receipts.ts` records mutations at the execution owner; the private daemon
protocol carries the same immutable identity independently of each IPC correlation ID. Same-intent
retries join in-flight work or return the recorded result. Parameter mismatch is refused. Response
retention is bounded, and admission epochs fence forgotten identities instead of replaying them;
a replacement daemon also has a different epoch. Read, attachment, and input streams remain separate.

The browser controller retains unresolved identities in tab-session storage before dispatch,
including across project changes and reload. Identified requests never silently fall back to
legacy unprotected execution. A query timeout cannot create a second terminal or restart it twice.
Storage/epoch/result uncertainty stays explicit rather than silently manufacturing a new intent.
Legacy HTTP callers without identities retain one-new-intent-per-request behavior; no new guarantee
is claimed for those callers. The in-process TerminalSessionManager uses the same owner-lifetime
receipt implementation and shared mutation dispatch; it never bypasses protection for fixtures.
Malformed stored key/path/method/body/identity relationships fail closed before new dispatch.

The required private protocol is now version 2. An existing version-1 daemon cannot supply these
mutation receipts. Ordinary Host launch leaves a listening incompatible daemon and its PTYs alone,
instead of using the old destructive replacement handshake. Applying terminal changes to such an
installation requires an explicitly authorized terminal-service restart after finishing terminal
work; restarting the Host alone intentionally reports terminal service unavailable. The synthetic
`terminal-daemon-launcher.test.ts` proves failed probe never sends replacement or spawns a daemon.

Unconfirmed controls use an independently bounded, non-overlapping recovery list identifying the
operation/target. Rechecking keeps the uncertainty visible while disabling only that check button;
local waiting never claims the operation is cancelled. Lazy tabs reference only mounted panels.
The rendered desktop regression also exposed readiness-driven xterm autofocus stealing focus from
recovery. `terminal-focus.ts` now gives only explicit/neutral activation one guarded animation frame;
fonts, replay, and writer-state callbacks do not reclaim focus. Explicit Take control remains a
local gesture, separate from actual input ownership.

### Maintenance restart authority

`server/maintenance-restart.ts` separates expiring prepare from committed drain. The runner in
`deploy/systemd/idle-maintenance-restart.mjs` inspects systemd first, then commits the exact owner
lease immediately before dispatch. An expired, released, foreign, or already-consumed lease cannot
authorize a restart. Committed drain cannot auto-expire while a delayed restart could still execute.

Release is owner-bound and invalidates even a reordered commit. It is allowed after failure before
issuance or proven failure to spawn systemctl, not after ambiguous command exit/timeout. Unknown
restart issuance retains drain and reports recovery required. Operator recovery must establish
that neither the old owner nor a submitted systemd job can still restart the Host. This trades
automatic availability for safety; it is not a new background retry loop.

## Evidence

All fixtures below are synthetic. No real conversation, compaction summary, user terminal content,
or daily-use Host/service was inspected or restarted.

- `tests/server/pi-rpc-ownership.test.ts`: long mutation waits, late read responses, bounded pending
  admission, correlated stream validation, shared stop fencing, delayed exit/tree signaling,
  spawn failure, and ownership-safe retirement.
- `tests/server/runtime.test.ts`: null completion allowances, preflight cancellation outside the
  FIFO, branch result fencing, failed stop barrier retaining writer exclusion, and upload cleanup
  failure remaining accepted.
- `tests/{server/app,web/api,web/composer-controller}.test.ts`: pending and retired receipts,
  observer disconnection, one dispatch, original operation IDs, and observation error versus
  operation refusal.
- `tests/{server,web}/terminal-operations.test.ts`: lost IPC/HTTP responses, same-intent concurrency,
  create/restart/close/settings outcomes, payload mismatch, retention/epoch fencing, and browser
  identity restoration. `terminal-inprocess-operations.test.ts` uses the real session manager with
  synthetic PTYs; `terminal-operation-restore.test.ts` validates stored intent before dispatch.
  Terminal receipt storage is bounded, not an exactly-once claim across a lost daemon epoch.
- `tests/server/maintenance-restart.test.ts`, `tests/deploy/idle-maintenance-restart.test.mjs`, and
  `tests/launcher.test.ts`: expiry during inspection, exclusive commit, stale/duplicate release,
  lost commit response, proven non-issuance, and ambiguous issued restart retaining admission drain.

### Real Pi regression

`tests/server/pi-operation-lifecycle.integration.test.ts` with
`tests/fixtures/pi-operation-lifecycle-extension.ts` passed twice on **Node 22.19.0 / Pi 0.85.1**.
It runs the actual browser API, authenticated Host, RuntimeController, PiRpcProcess, and installed
Pi CLI against a fresh loopback-only synthetic provider and synthetic session/configuration.
Discovery/tools and inherited credentials are disabled; only explicitly selected synthetic/Host
extensions load.

The long case keeps the real **20-second Host / 30-second browser windows** and has Pi itself select
pre-prompt threshold compaction. Its public compaction hook waits **35 real seconds**. At 31 seconds,
there is still one pending browser delivery and the same healthy worker; read-only Pi state says
compacting, with no premature model request or stop. POST occurred once, GET observes the same
identity without a body, compaction finishes, and both that prompt and a subsequent prompt settle
on the same PID. The synthetic disk has one compaction and exactly the two intended new turns.

The short case answers a real extension confirmation and then explicitly stops a second unanswered
confirmation. Stop completes without persistence-FIFO deadlock, confirms exit, and preserves the
interrupted delivery's unknown outcome. These two tests passed in approximately 37 seconds.

This integration is not a remote-provider/stock-LLM-compaction benchmark or OS-wide termination
proof. Windows process-tree behavior is covered by injected signaling/exit tests, not a Windows
kernel in this Linux run.

### Final verification

On **2026-09-08**, `npm run ci` passed on the final source tree using **Node 22.19.0 / npm 10.9.2**:

- Formatting, lint, TypeScript build, unused-code checks, and the production web build passed.
- Vitest: **1,464 passed, three skipped** (1,455 normal tests plus nine launcher tests).
- Node portable checks: **17 passed**.
- Chromium: **36 passed**, including the new operation-lifecycle tests on **1280×900 light** and
  **390×844 dark**, with reduced motion enabled and no axe violations in the terminal pane.

The browser tests use the real authenticated HTTP gateway and in-process terminal owner, lose a
committed create response, reload the page, and keyboard-retry the **identical operation identity**.
The catalog contains one terminal, not a duplicate. The recovery UI remains within both viewports;
late terminal initialization cannot steal recovery-button focus. Browser shell startup/settings/
history use a dedicated fixture home, not the developer profile. Screenshots are generated at
`output/playwright/operation-unknown-{desktop,narrow}.png` (untracked verification artifacts).

No real conversation or compaction summary was read; no daily-use Host, daemon, provider, terminal,
or systemd service was restarted. These are Linux-local checks, not a remote CI matrix or a
production deployment. Implementation closure: [[align-operation-lifecycles]].
