---
scope:
  - server/external-session.ts
  - server/pi-session-{activity,occupancy}.ts
  - server/runtime*.ts
  - server/herdr-*.ts
  - shared/contracts.ts
  - src/App.tsx
  - extensions/inspire-session-bridge.ts
  - tests/server/runtime-external-*.test.ts
  - tests/server/herdr-native-session*.test.ts
  - tests/server/pi-session-{activity,occupancy}*.test.ts
  - tests/fixtures/pi-resource-reload-extension.ts
  - tests/fixtures/pi-session-shutdown-extension.ts
  - tests/web/{readonly-session,session-activity}.test.ts*
---

# External Pi presence and native continuity

## Objective

Prevent Inspire from starting another writer for a session held by an independently running Pi,
while retaining readable history and useful activity indicators. Use supported Pi lifecycle
interfaces and process evidence, not a particular external host's control API.

## Current state

- Herdr native discovery remains the existing optional execution integration. Its process-birth
  evidence, unavailable-owner fence, cold settings admission and shutdown detach/drain are retained.
- The optional single-file Inspire session bridge lives in `extensions/inspire-session-bridge.ts`;
  the former `docs/examples/session-activity.ts` path forwards existing installations to it.
  It covers TUI/RPC/JSON/print and reports process-bound session
  presence separately from busy/input activity, and excludes the loaded Inspire-owned RPC bridge.
  In Herdr TUI only, the same installed entry also receives scope-bound native action frames through
  existing Herdr control; observation outside that connection remains read-only.
- A native session with no supported control connection is checked against reported presence
  inside cold writer admission and again after asynchronous pre-start preparation. A live external
  holder produces an `external-active` read-only view, not a new worker or an external control route.
- Idle, stale heartbeats, missing/corrupt reports and native metadata failures do not release known
  presence. Admission observations and retained-cache commits share one FIFO; older concurrent
  checks cannot roll a newer binding back. Positive fences survive Host replacement. Only completed producer
  rebind or confirmed process retirement releases the fence; PID reuse cannot inherit birth-bound authority.
- Shutdown is a pre-disposal boundary, not release. Current activity-stop hints and older `released`
  markers clear activity only. Native new/resume/fork uniquely matches shutdown/start reason and
  source/target paths before rebinding the same producer. Failed/ambiguous handoffs stay held;
  same-file replacement stays protected. Reused old SDK managers get independent report identities.
- Reload preserves the same report across extension-factory replacement. A lifecycle generation
  prevents shutdown during startup I/O from rearming a timer. SDK quit/dispose while its process
  lives has no reporter-visible persistence-drain completion signal and stays conservatively held.

## Viewed-session recovery

Following [[session-persistence]], subscribed external read-only sessions
recover automatically through existing writer admission after release. Ordinary presence checks
share one bounded observation timer; retained Herdr connections keep their existing polling.
The browser receives availability events without navigation or a new transcript view.

Confirmed native retirement triggers admission immediately;
ordinary presence is checked every two seconds while viewed. Observation does not replay input or
rewrite unchanged retained presence. [[follow-project-quality-2026-10-21]] tracks integration into `main`.

## Automatic idle handoff — deferred

The desired behavior is automatic control without a manual takeover workflow or complex machinery.
A candidate would let the identified native receiver retire when safe, then reuse viewed-session
recovery. That approach has not become an implementable design. The follow-up feasibility review
found no simple supported alternative for an already-running TUI; keep existing native control
rather than expanding this into a new lifecycle system.

Public-interface inspection and isolated Linux PTY probes on 2026-10-28 found a blocking distinction
in both the pinned Pi 1.3.0 and installed Pi 1.4.0:

- Start a native `! echo $$ > started; while [ ! -f gate ]; do sleep 0.05; done; echo finished > done`.
  Once its shell is live and waiting, the public extension context reports `isIdle() === true`,
  `hasPendingMessages() === false` and an empty editor.
- Calling public `ctx.shutdown()` in that state exits Pi and terminates the shell before `done`
  is written. It is orderly process shutdown, not a non-interrupting idle handoff.
- `AgentSession.isIdle` checks agent activity and compaction, not its separate Bash controllers.
  The public extension context exposes neither `isBashRunning` nor complete shell completion
  events. `user_bash` is an interception chain, not a complete operation-lifetime observer.

No automatic-exit code is enabled. Existing native control and confirmed-release recovery remain
unchanged. The probes used isolated offline configuration and disposable sessions; no production Pi,
Host or shared build output was changed, and the one-off probe was removed.

The follow-up review checked alternatives as well as shutdown:

- **Wait, then release by switching:** `waitForIdle()` uses the same agent-only state. An isolated
  Pi 1.4.0 SDK check returned from it while `isBashRunning === true`; `runtime.newSession()`
  replaced the session and cancelled the unfinished shell. The public runtime's common
  `teardownCurrent()` also disposes the old session on `switchSession()`.
- **Adopt the live TUI:** SDK exports expose the session/runtime a caller creates; neither the
  extension context nor RPC offers attachment to an existing interactive runtime or a live TUI-to-RPC
  mode switch. A custom launcher could own future sessions from startup, not adopt this native process.
- **Use Herdr state/control:** installed Herdr 0.8.6 (protocol 22) has no conditional agent-retirement
  operation. Its Pi integration v9 reports agent activity and blocked prompts, not native shell
  lifetime. `agent wait` observes that reported state; server live handoff preserves terminal
  processes during a Herdr update, not Pi session ownership.
- **Reconstruct activity in the bridge:** `user_bash` handlers short-circuit on a returned execution
  or result; a later observer can miss the operation altogether. Replacing shell execution, guessing
  from process trees/screens or patching the owning runtime would add complexity or violate the
  public-interface boundary.

The inspected upstream [extension types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
also lack owning-shell state or conditional retirement. The [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
and [Herdr automation](https://herdr.dev/docs/agent-automation/) document the respective ownership
and observation boundaries. Revisit only if a simple public adoption or non-interrupting release
path becomes available; no workaround or automatic-exit implementation is scheduled.

## Existing verification

- `herdr-native-actions.integration.test.ts` uses real offline Pi TUI/PTY with non-default Follow-up
  and Interrupt keys: native queueing, agent abort/queue restoration, below-editor widget/draft
  admission, a real dialog, extension command/template dispatch, handled input without a model turn,
  receiver retirement on reload, stale session rejection and original-terminal continuation. A gated
  native shell demonstrates why agent Stop cannot claim Bash cancellation. The independent real
  Herdr continuity case retains the same Pi across Host detach/reconnect with isolated user state.
- Transport tests require one exact process/session/receiver, reject mismatched or unavailable
  capability, preserve Stop ownership, distinguish invocation from rejection/unknown outcomes and
  never repeat a possibly delivered action. Prompt blocked admission is production code, not supplied
  by its test double.

- An isolated real RPC Pi is observed idle, working and settled while Runtime opens its session
  read-only and never constructs a replacement worker. Native resource reload keeps one report
  and the same PID. A later real shutdown hook is gated before appending its final custom entry:
  admission stays fenced during that hook, and only subsequent native startup releases the old file.
  The replacement check also holds an established Herdr-native connection: early destination
  metadata leaves it unavailable, completed reporter rebinding retires it, and ordinary occupancy
  admission then allows the old session. `pi-session-occupancy-native.integration.test.ts` uses a
  real independent Pi and reporter with a control-client double, not production sessions.
- The SDK disposal regression was observed failing before the fix. The real SDK disposal method,
  with a controlled later hook and busy session double, now keeps admission blocked both before
  disposal and afterward while the process is alive. Activity stop hints never authorize a writer.
- Producer tests cover all replacement reasons, wrong/ambiguous targets, old-manager reuse,
  same-file replacement, reload/late cleanup and shutdown overtaking startup publication. Native
  task results publish only at final settlement, retain consecutive short runs and stay scoped to
  their receiver. Loader coverage checks that legacy/current entries share one reporter per session
  while independent SDK sessions and reload keep their own lifecycles.
- The overlapping-admission regression also failed before its fix: a paused old cache rename could
  overwrite a newer binding, losing that protection after report loss and Host reconstruction.
  Serialized observation/commit now preserves the newer holder across that sequence.
- Presence regressions cover stale/legacy reports, deletion/corruption, Host reconstruction,
  completed rebind, current/legacy stop hints, PID retirement/reuse, path identity, and metadata/directory failure.
  A verified control-connection rebind commits its new retained binding before retirement; losing
  the report and reconstructing the Host cannot restore the old binding. A separate holder still
  blocks admission after that connection retires.
- Runtime regressions cover cold settings admission, second-check refusal with the reading view
  retained, preparation failure, startup failure without automatic restarts, deletion
  reservations, and shared subscriptions that leave during an observation and return.
  Unavailable observations retry without repeated UI events. Startup attestation invalidates
  a view whose history was replaced before Pi started. Late native state after retirement cannot
  restore the connection or its run state. Recovery does not change the Host's global selection.
  Existing Herdr control recovers in place rather than creating a local worker.
- A real PTY Pi exits through `/quit`; its still-viewed session then starts one RPC writer with
  the same transcript view, no replayed input, and a successful subsequent prompt.
- Browser-store checks cover draft/attachment preservation for both external read-only reasons.
  Isolated Chromium checks with real Pi cover ordinary presence (native control disabled) and Herdr
  retirement. Both retain the same transcript DOM, reading position, content and unsent materials,
  then persist exactly one explicitly submitted input and answer after recovery.
- Existing worker lifecycle/pool, startup attestation, persistence ownership, branch/settings and
  native Herdr tests remain part of the targeted verification.

## Activation and limits

Implementation evidence is separate from deployment. The Host must load the new admission code;
each external Pi must load the reporter through its own normal reload/restart. Refreshing a browser
or restarting Inspire does not reload an external Pi. Existing duplicate processes are not retired
by telemetry, and require lifecycle cleanup with the owning host.

There is no external module loader, MCP execution adapter or new ability to control arbitrary Pi.
A runtime that never loaded reporting or native discovery has no observable session evidence.
Pre-start observation is not an atomic cross-application reservation against an uncoordinated
simultaneous launch. [[session-persistence]] owns these boundaries and [[session-continuity]]
owns activity presentation; [the extension guide](../../docs/extensions.md#show-external-session-activity)
owns installation and activation.
