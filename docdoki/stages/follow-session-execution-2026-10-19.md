---
scope:
  - server/external-session.ts
  - server/pi-session-{activity,occupancy}.ts
  - server/runtime*.ts
  - server/herdr-*.ts
  - shared/contracts.ts
  - src/App.tsx
  - docs/examples/session-activity.ts
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
- The optional single-file Pi reporter covers TUI/RPC/JSON/print. It reports process-bound session
  presence separately from busy/input activity, and excludes the loaded Inspire-owned RPC bridge.
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

## Verification

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
  same-file replacement, reload/late cleanup and shutdown overtaking startup publication.
- The overlapping-admission regression also failed before its fix: a paused old cache rename could
  overwrite a newer binding, losing that protection after report loss and Host reconstruction.
  Serialized observation/commit now preserves the newer holder across that sequence.
- Presence regressions cover stale/legacy reports, deletion/corruption, Host reconstruction,
  completed rebind, current/legacy stop hints, PID retirement/reuse, path identity, and metadata/directory failure.
  A verified control-connection rebind commits its new retained binding before retirement; losing
  the report and reconstructing the Host cannot restore the old binding. A separate holder still
  blocks admission after that connection retires.
- Runtime regressions cover cold settings admission, a second pre-start check, release/reselection,
  and preserving existing Herdr control. UI checks retain history and inspection while withholding
  execution controls, with recovery on explicit reselect.
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
