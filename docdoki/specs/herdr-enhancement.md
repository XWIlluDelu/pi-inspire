---
purpose: Optional Herdr placement and connection to existing Pi terminals preserve session continuity and process ownership.
progress: in-progress
covers:
  - server/herdr-*.ts
  - server/pi-{rpc*,native-actions}.ts
  - extensions/inspire-session-bridge.ts
  - server/{runtime,runtime-worker-lifecycle,runtime-worker-pool,runtime-external-sessions,external-session}.ts
  - server/index.ts
  - server/preferences.ts
  - shared/contracts.ts
  - shared/herdr.ts
  - server/local-json-line.ts
  - src/components/*Settings*.tsx
  - tests/web/herdr-settings.test.tsx
  - tests/server/herdr-*.test.ts
  - tests/server/pi-{rpc*,native-actions}*.test.ts
  - tests/server/runtime-{worker-pool,worker-lifecycle,session-deletion,external-sessions}.test.ts
  - tests/browser/native-pi-continuity.spec.ts
  - tests/server/fixtures/native-herdr.ts
---

# Herdr enhancement

## Goal

- Users create and use sessions in the same Inspire GUI, with Herdr as an optional background environment.
- The default direct mode is complete without Herdr. Enabling it adds latent environment capabilities;
  it does not require a new agent feature or workflow.
- Sending, stopping, configuration, restart, pairing, and ordinary project terminals keep their semantics.

## Responsibilities

Pi and user configuration own tools, prompts, extensions, and collaboration under [[pi-integration]].
Inspire owns session identity, writer admission, operation receipts, projection, and GUI controls.
Herdr supplies project workspaces, panes, and their native environment.

Both owned-worker backends run the installed Pi in RPC mode with stdin/stdout pipes. The Herdr adapter starts an
Inspire bridge in a real pane and forwards the original RPC bytes over private IPC. The existing
Host parser and scheduler remain shared; the bridge owns transport and child cleanup only.
Extensions keep their Pi RPC compatibility requirements.

## Configuration and platform

- `herdrEnabled` defaults off and takes effect on Host restart. Settings distinguishes the saved
  choice, effective state, and availability; live workers keep their current backend.
- Availability reports explicit enabling readiness from the existing prerequisite and recovery checks.
  Known blocked status prevents enabling, remains recheckable, and never prevents disabling a saved
  choice. An installed server that can start on demand need not already be running.
- Enhanced workers require Linux, `/proc` process-birth evidence, a systemd user manager, and writable
  cgroup v2 scopes with `cgroup.kill`. Missing prerequisites produce a concrete error rather than a
  direct-backend fallback. Other platforms use direct mode.
- Disabled mode makes no Herdr process/API calls during ordinary startup or worker use. Retained
  leases still require recovery, and an explicit Settings availability query may probe Herdr.

## Placement and transport

- Group related workers by project. Create background panes through explicit returned workspace,
  tab, and pane identities, preserving focus. Stop and close only Inspire-owned resources.
- Launch through Herdr's `layout.apply` argv entry. Simulated keystrokes and terminal screen frames
  are unsuitable for ordered RPC transport.
- Bind each control request to the daemon incarnation with socket identity checks before and after
  connection. Herdr uses one request per connection; pane IDs can be reused by a replacement daemon.
- Give workers Inspire's resolved user exports, the same Pi installation/configuration as direct
  mode, and their new pane's genuine environment. Remove inherited worker and pane identities.
- Authenticate each launch over current-user-private IPC. Credentials and launch capabilities stay
  out of command text, terminal history, browser state, and diagnostics. Forwarding preserves RPC
  order, payload limits, and backpressure.

## Worker lifecycle

- Establish ownership before granting permission to start Pi. Each worker uses a standard systemd
  user scope, inherited by Pi's independently grouped Bash processes. Record boot, process-birth,
  and scope path/device/inode identity in the private lease before the grant.
- Ordinary stop first sends cooperative SIGTERM. Forced cleanup opens the verified cgroup directory,
  uses recursive `cgroup.kill`, and waits for `populated=0`, including after Pi or bridge death.
- Runtime retains the actual-stop barrier across explicit stop, unexpected exit, and idle eviction.
  A disconnected bridge or rejected stop cannot release it. Failed new-session creation retains
  its provisional reservation until retirement, even before Pi reports its native session file.
- Recovery processes old leases even when enhancement is disabled. A live previous Host retains
  ownership; otherwise the old worker scope must be empty before a new writer starts. A same-boot
  granted legacy lease without scope evidence remains blocked. A failed recovery is retried on
  the next worker-start request, sharing an in-flight attempt with other starts. Successful
  recovery stays established for the Host lifetime; later owned workers are not old recovery
  candidates. Status inspection reports the current result without starting recovery or cleanup.
- Host shutdown/restart ends its Pi workers; [[host-lifecycle]] defines Host-only and full restart.
  A shared Herdr server launched by a Linux Host service uses a separate user unit so it survives
  Host replacement. Failure to establish that unit fails startup instead of attaching it to Host.
- After verified Pi retirement, `pane_not_found` ends pane cleanup. `workspace_not_found` invalidates
  cached topology and permits one fresh allocation. Uncertain layout/connection results are not
  retried, and cleanup of an older pane cannot invalidate a newer workspace.

## Status and writer inspection

Reuse the existing conversation, attachment, branch, extension UI, Pending, Stop, and background
session surfaces. Runtime supplies a process-bound session id, run state, and `needsInput`.
The adapter reports `blocked` for input, `working` for active/queued work, and `idle` otherwise;
unchanged reports are coalesced.

Herdr receives the custom `inspire-rpc` agent/source and a display-only session-id token. Reporting
stops on retirement, while metadata remains until verified termination and owned-pane closure.
This RPC worker is distinct from Herdr's resumable native Pi TUI.

Before opening an existing file for writing, inspect Herdr's current native Pi path/id and sibling
Inspire session-id tokens, then check candidate panes for a live foreground Pi process. Historical
metadata alone cannot block admission. This is a pre-launch check of Herdr-reported writers;
other applications' unreported or later launches remain outside its authority.

## Existing native Pi sessions

- With enhancement enabled, opening a session already running in a Herdr Pi terminal connects
  Inspire to that process. The ordinary composer sends to it, new persisted messages appear in
  the conversation. Stop requests the original Pi's agent interruption; it is not a general
  terminal Escape action or a guarantee that terminal Bash stopped.
- Connection discovery matches the native session file or ID, current daemon incarnation and
  live foreground Pi identity. Stale metadata does not establish a connection, and ambiguous live
  matches are not chosen arbitrarily. Sibling Inspire RPC workers retain their existing writer
  admission rules.
- Native Pi processes are outside the owned-worker pool. Switching sessions, closing the browser,
  and Host shutdown/restart leave the native Pi and pane running. Independently running native work
  does not block Host maintenance restart; in-flight Host input, commands and interruption still do.
  Background history may be reclaimed independently of native status polling. Polling does not
  rebuild it; retained history uses version-checked reads, while prompt admission retains forced
  verification. Discarding an idle, unobserved runtime slot also releases its native connection;
  reclaiming only its history leaves status polling active. Repeated observation errors coalesce
  until a complete poll succeeds.
- Capture the native Pi's boot/process-birth identity before publishing its connection. A replaced
  Herdr server, missing agent/pane, or vanished session metadata does not establish that Pi exited.
  Keep its history read-only while ownership is unverified; an explicit reselect may connect through
  fresh discovery, never reused pane IDs from an obsolete connection. Original-process retirement
  releases that connection; late reads cannot restore its availability or apply run state.
  A completed reporter rebind may also retire it: the same captured producer and process birth
  must transfer the exact old file/session to the newly observed native target. Commit that
  verified binding before release so report loss cannot restore an old fence.
  For a session still viewed in a browser, release automatically resumes ordinary writer
  admission, including any other holder, without navigation, input replay or another polling delay.
  An unviewed session does not start a replacement worker. Metadata mismatch alone keeps the
  connection unavailable. Transient transport failures do not establish retirement, and uncertain
  input is never automatically resent.
- Reuse the installed `extensions/inspire-session-bridge.ts` in Herdr TUI instances. Herdr supplies
  existing terminal-control authority and status; a consumed, receiver-bound action frame invokes
  public Pi `sendUserMessage`, `ctx.abort`, `setSessionName`, `setModel` or `setThinkingLevel` in that same process. Neither user
  keybindings nor terminal screen geometry establish an action or editor state. The Host transport
  helper is internal code, not a second extension, listener or execution engine. Presence discovery
  alone never grants control. Read conversation content through the normal session projection.
- Bind requests and receipts to the live process birth, session file/id, extension receiver and
  invocation. Reload/replacement retires the receiver. Stage private payloads in the existing cache
  and trigger them only through the captured Herdr terminal. Remove transport files after observation;
  never automatically
  repeat an uncertain invocation. A receipt means the public function returned, not that input was
  admitted, a model ran, work stopped or settings persisted. Native asynchronous errors remain native.
- Preserve terminal drafts and dialogs. Ordinary nonempty editor text does not block browser input:
  public `sendUserMessage` leaves it intact. Pi owns its terminal queue and restores interrupted
  queued input there; a subsequent browser send remains available. Unanswered native dialogs block
  input without changing their contents. Target-side UI-prompt events guard input; Herdr blocked status is
  an additional prompt admission check, not a substitute for the target guard. Extension commands
  and templates retain native dispatch. `!`/`!!` and interactive built-ins without public callable
  actions direct the user to the original terminal instead of becoming model text. Commands/settings
  requiring an Inspire RPC worker likewise never launch another writer. Native extension `ctx.abort`
  cannot call TUI `abortBash`; Stop discloses its agent-only scope and directs terminal-shell
  interruption to the original terminal. This public-interface gap remains in [[pi-capability-gaps]].
- Model candidates come from the identified receiver's public `modelRegistry.refresh/getAvailable`,
  never another metadata runtime. The same private invocation payload returns the catalog outside the
  small presence record; regular observation carries only current selection and explicit support.
  Directory reads run independently of session controls, so slow discovery never queues Stop or input.
  Each invocation retains its own receipt in its private payload. Discovery has a 15-second cancellation
  budget and is cancelled on Stop, receiver retirement or removal of an abandoned Host request.
  Closing a connection abandons its reads, not the native Pi. Retired results cannot modify a replacement
  connection's catalog or selection. Delayed catalog and status observations may update candidates
  and activity, but cannot roll back a selection completed or observed since that read began.
  Model selection invokes `setModel` once, then reads actual `ctx.model/getThinkingLevel`. No second
  thinking write overrides native defaults or extension decisions. Thinking selection likewise returns
  the adjusted native value. Availability/ownership and activity remain separate from API support.
  Composer, palette and typed commands share support checks. Unsupported Reload/Compact offer native
  terminal guidance before busy checks; saved configuration and credential controls remain available.
- Images cross the bounded action payload as managed file references, then become real Pi
  `ImageContent` in the receiver before invocation. A receiver without image support requires native
  reload rather than silently sending text alone. Ordinary file/project references remain text.
  Attachments retain their normal budgets, preparation leases and release behavior. A stopped or
  replaced input cannot be delivered after preparation. An uncertain submission is not retried
  automatically, and any referenced files remain available to Pi.

## Automatic idle handoff

Opening a controllable native session in Inspire should automatically transfer it to an owned
worker once the original Pi can retire without interrupting work. Do not add a per-session
takeover button, confirmation or separate scheduling workflow.

- Limit handoff to sessions with live browser detail subscribers and an identified native control
  connection. Presence alone grants no authority. Explicit terminal-handoff intent opts out;
  unsupported receivers remain connected under the native controls above.
- Keep using the original Pi while it has work. The target must check agent work, queues, native
  shell execution and terminal interactions before accepting retirement. Preserve terminal drafts.
  A busy refusal leaves the connection usable for a later automatic check.
- Use a public, cooperative Pi retirement action bound to the current process/session/receiver.
  Its admission must not interrupt work arriving around the check. Do not infer safe retirement
  from a heartbeat, agent idleness or a terminal screen, or substitute signals/forced cleanup.
- After confirmed process exit, reuse viewed-session recovery and ordinary writer admission in
  [[session-persistence]]. Preserve reading state and browser input; never replay uncertain input
  or start a second writer. Leave the native pane and shell intact.
- Closing a view or Host does not itself request native retirement. A request already accepted by
  Pi may finish, but a replacement worker starts only while the session remains viewed.

This design does not change the external ownership fence before retirement. The missing public
safe-retirement interface and implementation state are recorded in [[pi-capability-gaps]] and
[[follow-session-execution-2026-10-19]].

## Checks

- Compare real-Pi startup, state, persistence, events, cancellation, and shutdown through both
  transports using isolated fixtures. Verify explicit pane selection and no-focus creation with a
  disposable Herdr server.
- Exercise launch/stream failure, Host/bridge/Pi death, detached Bash cleanup, and recovery with the
  enhancement disabled. Confirm pending and rejected retirement retain writer exclusion.
- Check stale topology, incarnation changes, writer inspection, coalesced status, and disabled-mode
  independence. Retain ordinary terminal and restart regressions.
- Use an isolated native Pi terminal to check browser submission, replies, reconnect, interruption,
  attachment delivery and draft preservation. Verify the same Pi survives Host close and rejects
  delivery after its session identity changes. Check native work does not block Host restart.
- Keep an established native control connection across a real isolated Pi/report lifecycle
  replacement. Gate outgoing shutdown, verify mismatch stays read-only, then retire the old
  connection only after native startup publishes the matching rebind. Cover report loss and Host
  reconstruction after committing the new binding. The occupancy/native integration suites own
  this combined check. Independent RPC presence and replacement run on every supported OS;
  Linux Herdr binding checks extend the shared native lifecycle fixture.
- Measure bridge overhead separately from model work, with the environment and sample scope recorded.

Herdr's [socket API](https://herdr.dev/docs/socket-api/) defines the argv layout and metadata interfaces.
