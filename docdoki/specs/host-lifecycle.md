---
purpose: "The loopback Host retains authenticated ingress, process and deployment ownership, safe build publication, and externally installed Pi authority across supported platforms."
covers:
  - inspire
  - inspire.mjs
  - deploy/systemd/**
  - scripts/{build-release,build-web,source-build-hash,verify-release-package,web-build-output,start-dev,start-dev-host}.mjs
  - scripts/vite-dev-launch.ts
  - vite.config.ts
  - tests/server/dev-launcher.integration.test.ts
  - server/{app,index,pi-rpc,pi-installation,preferences,access-token,terminal-daemon-launcher}.ts
  - server/{herdr-worker-entry,attach-control,runtime-extension-ui}.ts
  - tests/server/attach-control.integration.test.ts
  - server/user-environment.{mjs,d.mts}
  - server/platform-environment.{mjs,d.mts}
  - server/runtime-event-sockets.ts
  - server/browser-auth.ts
  - src/{api,browser-auth,terminal-connection}.ts
  - src/controllers/{connection-controller,terminal-operation-controller}.ts
  - tests/server/{app-auth,browser-auth,terminal-transport}.test.ts
  - tests/browser/pairing.spec.ts
  - server/{runtime,runtime-worker-lifecycle,runtime-events}.ts
  - server/{host-restart,host-restart-backend,host-restart-preparation,host-restart-systemd,restart-preflight}.ts
  - server/launcher-restart.{mjs,d.mts}
  - server/pi-processes.{mjs,d.mts}
  - tests/server/global-pi-restart.test.ts
  - shared/host-restart.ts
  - src/controllers/host-restart-controller.ts
  - src/components/HostRestartSettings.tsx
  - src/App.tsx
  - tests/web/startup-restoration.test.tsx
  - tests/restart-launcher.test.ts
  - tests/server/{runtime-worker-lifecycle,runtime-worker-pool,runtime-maintenance-restart,pi-startup.integration}.test.ts
  - tests/server/host-administration-api.test.ts
  - tests/web/host-restart.test.ts
  - tests/browser/{settings-layout,extension-ui}.spec.ts
  - server/{file-lock,current-web-build,instance-state}.mjs
  - server/instance-state.d.mts
  - server/instance-control.{mjs,d.mts}
  - tests/server/{instance-state,instance-control,host-shutdown.integration}.test.ts
  - tests/fixtures/host-control-faults.mjs
  - server/*diagnostic*.ts
  - server/host-restart*.ts
  - server/pi-worker-keeper.mjs
  - tests/server/pi-worker-keeper.test.ts
  - tests/launcher.test.ts
  - tests/server/terminal-daemon-launcher.test.ts
  - tests/portable/**
  - tests/server/{app,access-token,pi-installation,pi-rpc,current-web-build}.test.ts
---

# Host lifecycle, pairing, and distribution

## Goal

Launch, pair, package, diagnose, and stop one trusted local Host without exposing credentials or
making deployment machinery a second Pi runtime. Typed runtime integration is specified in
[[pi-integration]]; optional ingress is specified in [[connection-modules]].

The support baseline follows [[northstar]]. Windows native operations require PowerShell 7 from
named PATH locations or the standard Program Files installation; missing PowerShell is a dependency
failure, with no legacy-engine fallback.

## Runtime installation and release packaging

- Target the latest Pi release, with exactly pinned coding-agent/TUI development dependencies for
  typechecking, bundling and integration checks. Production uses external Pi; older versions have
  no maintained compatibility branches. Additional protocol capabilities require explicit
  negotiation; missing capabilities follow current public behavior. Production releases require
  zero `npm audit --omit=dev` advisories, without overrides or downgrades that conceal an affected
  dependency. [[dependency-boundaries]] owns runtime selection and licensing.

- The standalone npm CLI uses external Pi. `prepack` builds the Vite client and compiled Node Host.
  Release verification checks npm metadata with `npm publish --dry-run`, checks archive contents for
  optional service and extension files, and installs the exact tarball with production dependencies.
  The archive includes the built app and public examples. Tests and internal TypeScript stay in the
  source checkout.
  The installed CLI exercises the external Pi SDK and RPC, session recovery and a real PTY across
  Host restart. The Host and daemon must stop cleanly.

  The project is MIT-licensed. Every Vite build derives `dist/THIRD_PARTY_NOTICES.txt` from the
  actual bundled module graph; missing third-party license text fails the build. Locally bundled
  fonts keep their SIL OFL texts, and release verification checks the installed font assets against
  the reviewed checksums.

- Pi’s saved project-trust policy remains authoritative; the host does not load project resources
  through a separate bypass path.

## User execution environment

- Direct local launches inherit the caller's exported environment. Installed POSIX services resolve
  the user's login/interactive shell exports once at startup, before dependency preparation, Pi
  discovery, or runtime creation. Their fixed Node search path is bootstrap-only, not the user's
  development-tool PATH. Delegating a CLI command to an already installed service does not transfer
  the calling terminal's transient exports to that service.
- `INSPIRE_ENVIRONMENT=inherit|shell` selects an explicit launch policy; the default is shell for
  installed services and inherit for direct launches. `INSPIRE_SHELL` overrides `SHELL` and the
  account's default shell for export discovery. Unsupported shells or platforms fail explicitly
  instead of substituting an incomplete environment. Windows direct launch inherits.
- Discovery runs normal login/interactive initialization from the user's home without a PTY.
  The export record is limited to 1 MiB, excluding discarded startup output; the whole probe has a
  ten-second deadline and terminates its isolated group on failure. Failed/incomplete discovery
  prevents launch. Never log or persist shell output or environment values. Preserve user unsets,
  service identity and explicit Inspire controls; omit probe-only state. Children inherit the result
  without probing again, while terminal tabs retain their own initialization.
- Application-specific settings must not rewrite unrelated user variables. Inspire does not force
  `NODE_ENV`; an unset, empty, or user-supplied value is preserved through Host, Pi, and project
  terminals. Express owns its production HTTP mode locally. An explicit
  `INSPIRE_TERMINAL_IN_PROCESS` flag, not a user's NODE_ENV, selects the test-only in-process owner.
- Transient terminal services carry exports through systemd without command-line values or the
  Host's service identity. Installed unit files must not snapshot credentials or the installer's PATH.
  Changing a running daemon's environment requires an explicit terminal restart. The
  [operator guide](../../docs/host.md#shell-startup-problems) covers older units with a NODE_ENV override.

This contract covers exported variables and executable lookup, not aliases, shell functions, or
virtual environments activated only in another terminal tab. [[platform-compatibility]] explains the
capture mechanism and service handoff.

## Pairing and authenticated ingress

- Browser pairing registers a non-extractable P-256 ECDSA key, persisted in the browser origin's
  IndexedDB with a public HMAC-SHA256 Host certificate binding the public key and canonical origin.
  The Pair form proves the Host master token once. Local startup/reopen/status links instead
  contain a one-use, 30-second origin-bound bootstrap fragment, minted in-process or obtained
  through an authenticated local-control action. The reusable token never appears in the printed
  URL, browser opener arguments or navigation request. The bundle removes the fragment from history
  before registration. Readiness does not allocate pairing transfers. An explicit `inspire token` command
  verifies the matching Host before printing its token for manual remote pairing; ordinary lifecycle
  commands do not print it. Pairing uses the form or a bootstrap fragment. Valid stored pairing
  takes precedence over an expired/spent transfer. After authority rotation a fresh transfer can
  register a new key.

- A valid certificate admits a random, origin-bound 30-second challenge, consumed once before
  signature verification. A successful SHA-256 signature yields a five-minute API bearer held only
  in page memory. Certificates and access bearers use separate MAC domains/types. They survive
  Host restart with the same master token; rotation invalidates both immediately. The browser
  refreshes credentials before dispatch and never transparently replays a request after 401 or an
  uncertain mutation outcome. Reconnect obtains authoritative snapshots and retains prompt receipt
  semantics. Same-origin tabs share a stored key but acquire independent memory bearers.

- API reads/mutations, including resource previews and export blobs, require an explicit bearer.
  Browser transport refuses foreign-origin inputs and redirects, omits cookies, and never persists
  API bearers. Browser events and terminal upgrades require a 15-second single-use ticket bound to
  canonical origin and audience, minted through an authenticated exact-origin POST. Terminal
  attachment separately retains its terminal-bound, origin-bound one-use attach ticket and daemon
  ownership rules. Trusted explicit non-browser API clients retain master bearer headers;
  non-browser event clients may also use a master bearer header without Origin. Automatic CLI
  readiness and maintenance use the peer-authenticated local control protocol below, never a
  master bearer sent to an unverified listener.
  Master/API bearer query tokens and cookies never authenticate APIs or sockets.

  Native file downloads use a separately bounded 15-second one-use transfer ticket minted by
  authenticated fetch, bound to canonical origin, session and resource. Consumption requires exact
  same-origin evidence and rechecks resource/view authority before streaming raw bytes. Native
  WebKit downloads can omit both Origin and Fetch Metadata; only in that absence may a strictly
  same-origin Referer supply the proof. Any conflicting explicit Origin, Fetch Metadata or Referer
  still rejects without consuming the ticket. The download anchor sends origin-only referrer
  information, not page paths or queries; there is no credential/cookie fallback. Pending issuance,
  preview limits and buffering follow [[resource-preview]]. Interactive preview grants are
  revocable session/view-scoped document capabilities, not Host credentials.

- Pending challenges, bootstrap transfers, socket tickets and download tickets each have a 1,024-entry process-local
  bound. Expired entries are pruned before admission; capacity fails closed without replacing live
  entries. Restart retires these one-use grants. Pairing requires WebCrypto and origin IndexedDB;
  unsupported or blocked storage produces useful Pair feedback, never a weaker fallback.

- Without explicit `INSPIRE_TOKEN`, generated tokens contain 64 cryptographic random bytes
  (86 base64url characters), in a current-user-private `0700` directory and `0600` plain-text
  `.token` file keyed by installation/host/port. Existing non-private POSIX parent directories are
  refused without changing their permissions; new parents are created private. A stored generated
  token must have the current format. An invalid token file is reported and left in place for
  explicit replacement and re-pairing. Noninteractive Host services suppress token-bearing startup
  output so it cannot enter their journal.

## Development launch

- The coordinated source-development entry uses a fresh private credential and control directory,
  not inherited production token/state/stop-request paths. No reusable credential is printed or put
  in an opener URL. Backend source watching retains that run’s authority across reloads.
- Vite owns a strict loopback listener before issuing an opener. It binds explicitly rather than
  assuming localhost and numeric loopback addresses are interchangeable. Backend/proxy addresses
  follow the same selected Host configuration. An occupied frontend/backend port fails without
  opening or stopping its unrelated occupant.
- Pairing requires authenticated readiness of the current private Host and a one-use grant bound to
  the actual Vite browser origin. Only an authenticated local-control request may select a canonical
  HTTP loopback proxy origin; normal production link validation still defaults to the Host origin.
  The existing Vite open action obtains a fresh transfer rather than reusing an expired URL.

## Instances and local control

One Host runs per installation, address and port. The CLI finds and controls it through signed
local requests, never by sending the reusable Host token.

- The host binds only to loopback and does not directly expose unrestricted Pi control to another
  machine. Automatic desktop-browser opening is best-effort: a missing or failed OS opener is
  diagnosed but never terminates the already-listening Host. Optional [[connection-modules]] own
  only their local companion-process lifecycle and ingress path; they never become Pi/data authority
  or own host shutdown. Forwarded protocol is trusted only from a loopback hop.
- Production launch is single-instance per checkout, host and port. Reuse requires matching private
  state, support for signed local control, and a fresh authenticated HTTP readiness result.
  An unsupported live owner blocks takeover. Case aliases are verified against the native
  directory identity, so distinct case-sensitive roots remain distinct on Windows.
- The local HTTP control protocol binds each request and response to the current published state
  format, installation, address, process birth, startup incarnation and systemd invocation when
  present. Domain-separated HMACs authenticate a fresh
  nonce, action, deadline and payload without sending the reusable Host token. Readiness,
  pairing-transfer issuance and maintenance prepare/commit/release use this protocol. One-use
  requests expire within 15 seconds, live replay records are bounded at 1,024, and request/response
  bodies are bounded at 2 KiB. The client
  rejects unsigned/mismatched replies, redirects, oversized bodies and expired results even when an
  overdue abort timer has not yet run. Only the Host's own ready publication can sign replies.
- Launcher lock ownership is explicit and scoped: `restart` retains exactly one lock from its stop
  boundary through the replacement start, including when no managed instance existed, while
  standalone `stop` releases any lock before every return.
- Preference read/merge/rename writes are serialized both within one Host and across independent
  Host processes through the same bounded lock abstraction used by single-instance launch. Linux
  uses kernel `flock`; macOS and Windows use an atomically published ticket queue whose owner
  records include the process birth identity and are reclaimed only after that exact process is
  gone, so field-scoped patches from different processes cannot restore stale values for unrelated
  fields.

### Shutdown

- Managed shutdown has an HTTP-independent local control capability: bounded atomic
  request/result files beside instance state, authenticated with domain-separated
  HMACs using the existing private Host authority without serializing its token. Requests expire and
  bind root, address, process birth, startup incarnation and service invocation. Old, forged or foreign requests
  cannot stop a replacement or another instance.
- The Host retains its cooperative control loop if HTTP stops listening. It runs the same application,
  owned-worker and backend cleanup as ordinary shutdown and signs the outcome before exiting. CLI
  replacement requires both a clean authenticated result and confirmed OS process exit; state-file
  disappearance or a result alone is insufficient. Failed/unknown cleanup and a blocked event loop
  do not authorize PID killing or replacement. The launcher lease still fences handoff.
- Send WebSocket close notifications before runtime teardown, then terminate remaining upgraded
  connections after the event-loop drain opportunity. Include pre-attach and already-closing peers
  so a missing browser acknowledgement cannot hold Host exit until the library handshake timeout.
  Endpoint close callbacks, including terminal detach, precede service-client close; owned-worker
  and PTY exit still require separate confirmation.
- A stop racing dependency installation or build cancels that pending start. The CLI stops a
  published Host through authenticated shutdown. Stop an older Host through its running
  launcher's control or service manager before upgrading to the current state format.

## Worker processes

Inspire's own Pi workers are child processes the Host owns; terminal Pi and attached Pi are not.

- The direct POSIX backend launches each Pi worker in an isolated process group; eviction,
  protocol-boundary failure, and shutdown signal that group. Pi's Bash tools create separate groups,
  which Pi cleans up during cooperative exit; a killed Pi cannot perform that cleanup. The optional
  [[herdr-enhancement]] backend owns these detached descendants through a per-worker kernel scope,
  including hard termination and recovery; direct mode gains no systemd dependency.
- Windows terminates the worker's descendant tree through `taskkill /T`, escalating
  with `/F` only for the existing hard-kill boundary and falling back to Node's direct child signal
  only when the operating-system tree command cannot complete. A tracked child already known to have
  exited never authorizes another numeric PID/PGID signal on any platform. POSIX group signalling
  stays adjacent to the live tracked-child observation; no post-exit group identity is inferred from
  its old PID. A stop awaits real child exit and already-started tree operations, not a signal
  or pipe-close deadline.
- Native commands receiving copied Windows environments resolve SystemRoot
  case-insensitively. Repeated lookups of the current process share its immutable birth identity;
  foreign PIDs are always re-queried and failed self lookups remain retryable.
- Direct workers use Pi's RPC stdin and stdout. Herdr workers forward the same RPC through the
  pane bridge. The Host retires its workers during shutdown. If the Host disappears, direct Pi
  workers receive EOF and the Herdr bridge stops its worker scope when the RPC sockets close.

## Installed Linux services

- A matching installed `inspire-host.service` is the lifecycle authority for that checkout: ordinary
  `./inspire`, `status`, `stop`, and `restart` delegate only after its fragment path, working
  directory, `ExecStart`, and authenticated readiness hook identify the same root. Service
  activation completes only after that hook authenticates the Host readiness result. Ordinary
  status also requires the live authenticated Host; an active process alone is not availability.
  The unit's own `ExecStart` bypasses delegation so it cannot recurse; explicit
  alternate-instance inputs and checkouts without the unit retain direct-launcher behavior.
  Instance selection compares the effective host, port, and state path with the installed default;
  merely inheriting those same values does not bypass its service manager. An explicit credential
  delegates only after authenticating the same running instance and matching that credential.
  A foreign or outdated installed unit still fails closed instead of falling back to reparenting
  the same Host.

### Scheduled maintenance

Installing the host also installs an optional 04:00 user timer; enabling the Host does not enable
it. Scheduled maintenance requires separate operator opt-in. Disabling the Host also
stops/disables its timer so it cannot restart a disabled service.

The timer never fetches updates: it restarts only if the installed external Pi version or a clean
source revision differs from the running identity, Inspire-owned workers have no active
run/dialog/queue, and no Host operation is in flight. Independently running external Pi does not
block maintenance; a Host submission to it still does. A busy, dirty, indeterminate, or old Host
is skipped without force or same-day retry.

Scheduled restart uses a single-owner handoff through signed actions at `/api/host/local-control`.

1. `maintenance-prepare` grants an opaque `leaseId` and 30-second `expiresAt`.
   Preparation blocks new work but does not authorize restart. The runner binds its plan to
   the invocation published by the issuing Host. After systemd ownership checks,
   `maintenance-commit` validates that current, unexpired lease and idle runtime,
   then synchronously commits the drain. Only its matching `committed` response authorizes one
   external restart; duplicate, expired, released, foreign and previous-Host leases cannot do so.
   Preparation may expire and reopen admission; a committed drain never auto-expires.
2. Do not retry commit or consume a late response after timeout. Before command issuance,
   cancellation, failed inspection or a lost commit response triggers owner-bound
   `maintenance-release`. Release invalidates the identity, including reordered
   commits. Proven failure to spawn systemctl also permits release. Once issued, an exit failure,
   signal or lost result leaves restart uncertain: retain the drain and report recovery required.
   Report lost release acknowledgement too. Lease capabilities stay out of logs and persisted
   runner state.
3. Recovery requires establishing both that the owner can no longer issue its command and that
   no submitted systemd restart job can still execute. Only then may the retained owner release
   its lease, or an operator replace the Host if the identity is lost. Time passed, runner exit
   or an active service alone is insufficient: an old runner/job could restart the replacement
   after new work begins. The handoff does not provide a durable transaction across manual Host
   replacements.

## Explicit restart controls

The page uses a lifecycle receipt tied to the original Host and operation ID. A submitted
restart stays pending until the browser observes a different Host identity. A rejection or
unconfirmed submission keeps its domain phase and does not trigger a new restart automatically.

### Scope and preparation

- `inspire restart` prepares dependencies/client build and imports the next runtime and external
  Pi SDK before stopping the Host. Preparation failure leaves it running. Ordinary restart ends
  Inspire-owned Pi workers and keeps the independent terminal daemon.
- `inspire restart --terminals` requires this installation\'s verified Linux systemd Host and terminal
  units. It restarts both in one transaction, with Host ordered after terminal readiness, ending
  project terminals in the installed unit. An independent daemon retained from a direct launch
  keeps its own lifecycle under [[terminal]]. Run terminal-closing commands from an external OS
  terminal. Unsupported or foreign services are refused before stopping anything, connection
  services remain outside the scope, and a failed service restart cannot fall back to a local Host.
- **Restart all** and `inspire restart --all` additionally close current-user Pi processes regardless
  of their owner. Include Herdr Pi only when the running Host has enhancement enabled; otherwise
  preserve them. Read the effective mode, not the saved next-start preference. The Herdr server
  itself stays running. The CLI stops the managed Host/terminals before process cleanup and starts
  them only after cleanup succeeds. If no Host is running, Herdr Pi are excluded.
  The CLI reads the static effective mode through signed local control, without sending a reusable
  bearer or probing Herdr. Reject Pi-descended CLI callers before preparation: terminating their
  parent Pi could kill the restart coordinator before it starts Inspire again.
- **Restart** and **Restart all** live in Settings → System → Host, with concise confirmation
  for each scope. Restart supports launcher-owned native Windows, macOS, and Linux instances,
  including custom loopback addresses, ports, and state paths. Installed Linux services retain their
  exact running systemd invocation as authority. A raw Host entrypoint without either owner cannot
  restart itself.
  Full restart remains restricted to the installed Linux services and names the terminal-process
  impact. Ordinary and full availability are exposed and enforced separately; unsupported scope is
  refused before preparation or work interruption. Restart stays out of the command palette and
  always-visible controls. Pairing and local-offline recovery guidance must work for both installed
  packages and source checkouts without assuming a POSIX-only wrapper.
- Direct page restart uses the existing launcher's private child IPC, not a browser-supplied command,
  PID, or detached replacement launcher. Keep the original launcher and instance lock across
  replacement, reuse its environment and instance configuration, and do not reopen the browser.
  Restart only after an accepted handoff and a distinct successful restart exit; failed worker
  retirement, a crash, an ordinary stop, or a signal cannot authorize a replacement. Standalone stop
  waits for the launcher's lock before clearing cancellation, including when Host state disappeared
  before actual process exit.

### Identity and admission

- An authenticated request binds its UUID, scope, and optional `interruptWork: true` grant to one
  Host incarnation. Scope and permission are immutable under that identity. Retain up to 32
  identities for the Host lifetime; repeats return the same operation. Admit only one pending
  intent, and reject identities from a previous Host. GET exposes preparation and outcomes to all
  observers; HTTP deadlines end observation, not the submitted restart.
- Preparation leaves Pi admission open. Afterwards, an ordinary page request must acquire a fresh
  exclusive idle lease. Idle live workers are allowed. A failed startup ceases to block once its
  worker has retired; preserve the original error for diagnosis. Pending or rejected actual-stop
  acknowledgements still block ordinary admission, even if the worker no longer appears live.
- After a workload refusal, the affected restart row offers **Stop work and restart** and the
  status row shows why the attempt stopped. Clicking the action authorizes interruption of active
  Inspire-owned and taken-over Pi work in that scope without a second confirmation. It bypasses
  workload checks while keeping preparation, service ownership, lease exclusivity and final commit.
  Automatic maintenance keeps its update and idle checks and restarts only the Host service.
- **Restart** replaces Inspire-owned Pi workers. Attached Pi processes keep running with their
  loaded settings. Pi exposes reload through its own `/reload` command. An ordinary restart counts
  busy taken-over Pi as active work and reads it directly before submission. Unavailable observation
  blocks restart. **Stop work and restart** explicitly interrupts its attached branch; if Stop
  cannot be confirmed, report the affected sessions and offer **Restart anyway** without another Stop.
- **Restart all** confirms Pi termination before submission and requires `interruptWork: true`.
  Acquire and commit the same restart admission lease, then terminate the selected Pi processes
  before issuing the service restart. It does not depend on attached-Pi Stop acknowledgement.
  The `all-pi` API scope is available when the installed services and Pi process control are ready.
- Linux process cleanup snapshots exact `pi` and `pi-rpc` titles owned by the current OS user.
  Herdr pane/socket environment markers identify Herdr Pi. Revalidate birth ticks, ownership,
  title and inclusion before each signal; send SIGTERM, wait up to five seconds, then SIGKILL
  surviving identities and verify exit. Never signal shells, Herdr, the Host, or a reused PID.
  Fresh final discovery must confirm that no included Pi remains. Discovery, signalling or exit
  verification failures prevent restart and report the failure, including partial shutdown.
- CLI restart verifies the running Host with signed readiness. A managed shutdown waits for
  actual process exit and a signed cleanup result before starting a replacement.

### Submission and recovery

- Recheck the live launcher channel or current service invocation before committing the non-expiring
  drain and submitting the restart. The systemd plan rechecks the captured invocation after commit
  and again after any Pi cleanup. The existing Host shutdown retires its workers. Proven
  non-issuance releases admission; uncertain submission retains the drain and reports recovery
  required. A lost launcher acceptance cannot trigger shutdown from a late reply or turn a later
  normal exit into a restart.
- The browser persists identity in tab-session storage before POST; invalid or unavailable storage
  blocks dispatch, not read-only Host observation. Recheck retries local recovery and clears the
  browser's blocked state once storage recovers. Retrying an unconfirmed request keeps its identity.
  A new Host identity or a matching rejected operation automatically retires browser tracking;
  uncertain requests keep their identity. Only malformed saved data offers **Reset restart
  recovery…**, beside its error and with confirmation; normal pending/recovery controls and
  unavailable storage (which retries) offer no local-record cleanup. Reset discards only browser
  tracking, neither sending nor cancelling a restart; the Host's pending operation still fences new
  admission. Failed local cleanup preserves the record and reports a storage problem, not an
  unknown restart. A rejected receipt is labelled **last attempt**, because it is historical rather
  than a current busy check. A new submission replaces the old result with preparation immediately.
  A POST receipt establishes the operation before polling catches up. The status row reserves room
  for ordinary progress and refusal so these transitions keep their layout.
- The CLI checks readiness after restart; the browser reports reconnection to a new Host.

## Atomic browser-build publication

- Source builds and the launcher share one browser-input hash. Successful `build:web` writes a
  checkout stamp from the inputs sampled before compilation; saving changed inputs during a build
  leaves that stamp stale so the next launch rebuilds. A current stamp avoids rebuilding at startup.
  The npm distribution omits the stamp and uses its packaged build.

- Source builds stage Vite output behind one installation lock and publish assets before
  switching the index. A current manifest identifies the browser build and the assets it can
  serve. After publication, old files are removed when possible and are excluded even if still
  present on disk. Current JavaScript and CSS retain immutable validators, ranges and negotiated
  Brotli/gzip variants. A missing asset returns `404` without falling through to the shell.
- Paired browser requests and socket admission use the current build identity. The development
  browser and Host share their development identity. A stale browser is told to reload, stops
  reconnecting, and keeps its open draft for copying or manual reload. Native sessions and
  notification storage are independent of shell publication.

## Diagnostics

- Projection and RPC diagnostics are durable enough to explain an ownership rejection after the
  fact. A private rotated JSONL log correlates host id, slot incarnation, session/worker/PID, RPC
  id/type/timing, projection revision/fingerprint/identity/bytes, persistence expectation
  transitions, ownership-decision reason, and an opaque incident id shown in conflict UI. Logging is
  metadata-only: prompts, message text, tool results, extension payloads, credentials, tokens,
  absolute working directories, and raw child stderr are excluded. POSIX directories/files are
  `0700`/`0600`; Windows uses the current user-profile ACL boundary. A configured path is accepted
  only inside an existing private current-user directory.

## Checks

- Production has one Host/Runtime path. Browser acceptance uses isolated native session files,
  real workspace resources and Pi with a deterministic offline provider. Presentation fixtures and
  narrowly scoped transport faults do not implement a second runtime or fabricate mutation results.
