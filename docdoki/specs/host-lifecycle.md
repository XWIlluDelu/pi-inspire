---
purpose: "The loopback Host retains authenticated ingress, process and deployment ownership, safe build publication, and externally installed Pi authority across supported platforms."
covers:
  - inspire
  - inspire.mjs
  - deploy/systemd/**
  - scripts/{build-release,build-web,source-build-hash,write-build-stamp,verify-release-package,web-build-output,start-dev,start-dev-host}.mjs
  - scripts/vite-dev-launch.ts
  - vite.config.ts
  - tests/server/dev-launcher.integration.test.ts
  - server/{app,index,pi-rpc,pi-installation,preferences,access-token,terminal-daemon-launcher}.ts
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
  - shared/host-restart.ts
  - src/controllers/host-restart-controller.ts
  - src/components/HostRestartSettings.tsx
  - src/App.tsx
  - tests/web/host-recovery.test.tsx
  - tests/restart-launcher.test.ts
  - tests/server/{runtime-worker-lifecycle,runtime-worker-pool,runtime-maintenance-restart,pi-startup-retirement.integration}.test.ts
  - tests/{server,web}/host-restart*.{ts,tsx}
  - server/{file-lock,static-asset-cache,instance-state}.mjs
  - server/instance-state.d.mts
  - server/instance-control.{mjs,d.mts}
  - tests/server/{instance-state,instance-control,instance-shutdown-control,host-shutdown.integration}.test.ts
  - tests/fixtures/host-control-faults.mjs
  - server/*diagnostic*.ts
  - tests/launcher.test.ts
  - tests/user-environment-launcher.test.ts
  - tests/server/terminal-daemon-environment.test.ts
  - tests/portable/**
  - tests/server/{app,access-token,pi-installation,pi-rpc,static-asset-cache}.test.ts
---

# Host lifecycle, pairing, and distribution

## Goal

Launch, pair, package, diagnose, and stop one trusted local Host without exposing credentials or
making deployment machinery a second Pi runtime. Typed runtime integration is specified in
[[pi-integration]]; optional ingress is specified in [[connection-modules]].

The support baseline is current supported systems and reasonably recent dependencies, not a
historical-version matrix. Windows native operations use PowerShell 7, resolved from named PATH
locations or its standard Program Files installation. They do not silently select the legacy
inbox engine. Missing PowerShell is a dependency failure, not permission to weaken identity or
storage checks.

## Runtime installation and release packaging

- INSΠRE targets the latest Pi release. Pi's coding-agent and TUI packages are pinned exactly as
  deterministic development dependencies for type-checking, browser bundling, and installed-Pi
  integration suites; the checkout copy is not a production runtime. Older Pi versions have no
  maintained compatibility branches. Optional capabilities beyond the current public protocol remain
  inactive unless explicitly negotiated; absence follows current public behavior rather than version
  guessing. Production releases require zero `npm audit --omit=dev` advisories, without root
  overrides or downgrades that conceal the affected dependency. [[dependency-boundaries]] explains
  runtime selection and release checks.

- The npm release is a standalone cross-platform CLI/application package, not a Pi resource package:
  it intentionally declares no `pi` manifest or `pi-package` keyword and contains no Pi runtime
  dependency. `prepack` produces the Vite client and compiled Node host; the verifier requires
  canonical npm bin metadata, accepts the exact tarball through `npm publish --dry-run` without
  metadata correction, excludes tests and TypeScript source, proves Pi is absent after a
  production-only install, and then proves that installation can start, report status, serve
  authenticated mock health, stop, and create a real session using one explicitly supplied external
  Pi package for both SDK and RPC.

  The project is MIT-licensed, and every Vite build derives `dist/THIRD_PARTY_NOTICES.txt` from the
  actual bundled module graph; missing third-party license text fails the build, while locally
  bundled fonts retain their separate SIL OFL texts.

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
  rather than silently substituting an incomplete environment. Windows direct launch inherits.
- Discovery invokes the selected shell's normal login/interactive initialization in the user's home,
  without a PTY, then exports a uniquely framed record through its stdout pipe. Startup output is
  discarded without counting toward the 1 MiB export limit. The entire probe has a ten-second
  deadline, terminates its isolated group on failure, and never logs or persists shell
  output or environment values. Failed or incomplete discovery prevents the new launch. User
  unsets are preserved; service identity and explicit Inspire controls survive shell initialization.
  Probe-only state is not propagated, and children inherit the resolved environment without probing
  again. Actual terminal tabs retain their own normal initialization.
- Application-specific settings must not rewrite unrelated user variables. Inspire does not force
  `NODE_ENV`; an unset, empty, or user-supplied value is preserved through Host, Pi, and project
  terminals. Express owns its production HTTP mode locally. An explicit
  `INSPIRE_TERMINAL_IN_PROCESS` flag, not a user's NODE_ENV, selects the test-only in-process owner.
- Transient terminal services carry the supplied exports through systemd without placing values in
  command arguments or reusing the Host's service identity. Installed services do not snapshot
  credentials or the installer's PATH in unit files. Existing units require reinstallation to remove
  the former terminal NODE_ENV override; applying that change to a running terminal daemon requires
  an explicit terminal restart, never an implicit interruption of its PTYs.

This contract covers exported variables and executable lookup, not aliases, shell functions, or
virtual environments activated only in another terminal tab. [[platform-compatibility]] explains the
capture mechanism and service handoff.

## Pairing and authenticated ingress

- Browser pairing registers a non-extractable P-256 ECDSA key, persisted in the browser origin's
  IndexedDB with a public HMAC-SHA256 Host certificate binding the public key and canonical origin.
  The Pair form proves the Host master token once. Local startup/reopen/status links instead
  contain a one-use, 30-second origin-bound bootstrap fragment, minted in-process or obtained through
  an authenticated local-control action. The reusable token is not placed in the printed URL, browser
  opener arguments or navigation request. The bundle removes the fragment from history before
  registration. Readiness does not allocate pairing transfers. An explicit `inspire token` command
  verifies the matching Host before printing its token for manual remote pairing; ordinary lifecycle
  commands do not print it. Legacy direct loopback token queries still redirect into a one-use
  transfer; HTTPS proxies strip token queries without pairing. Valid stored pairing takes precedence
  over an expired/spent transfer; after authority rotation a fresh transfer can register a new key.

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
  Master/API bearer query tokens and cookies never authenticate APIs or sockets. Native file
  downloads use a separately bounded 15-second one-use transfer ticket minted by authenticated
  fetch, bound to canonical origin, session and resource. Consumption requires exact same-origin
  evidence and rechecks resource/view authority before streaming raw bytes. Native WebKit downloads
  can omit both Origin and Fetch Metadata; only in that absence may a strictly same-origin Referer
  supply the proof. Any conflicting explicit Origin, Fetch Metadata or Referer still rejects without
  consuming the ticket. The download anchor sends origin-only referrer information, not page paths
  or queries; no credential/cookie fallback is introduced.
  Selecting another resource/session/view/transport retires pending issuance; no preview size cap
  or JavaScript file buffering is introduced. Interactive preview grants remain
  revocable session/view-scoped document capabilities, not Host credentials.

- Pending challenges, bootstrap transfers, socket tickets and download tickets each have a 1,024-entry process-local
  bound. Expired entries are pruned before admission; capacity fails closed without replacing live
  entries. Restart retires these one-use grants. Pairing requires WebCrypto and origin IndexedDB;
  unsupported or blocked storage produces useful Pair feedback, never a weaker fallback.

- Without explicit `INSPIRE_TOKEN`, generated tokens contain 64 cryptographic random bytes
  (86 base64url characters), in a current-user-private `0700` directory and `0600` plain-text
  `.token` file keyed by installation/host/port. Existing non-private POSIX parent directories are
  refused without changing their permissions; new parents are created private. All cookie-era
  generated lengths, including 64
  characters, rotate once on the next Host start; later starts reuse the new generation. Explicit
  configured tokens are never silently rewritten: operators must rotate a formerly cookie-paired
  configured token to revoke leaked explicit-bearer authority. See
  [migration guidance](../../docs/host.md#migration-from-cookie-pairing).

- Responses expire only the current Host's qualified legacy cookie and the old unqualified
  `inspire_access` cookie when present, leaving unrelated data/other qualified Host cookies alone.
  Old bundles fail safely and must reload/pair, without insecure compatibility. Noninteractive Host
  services suppress token-bearing startup output so it cannot enter their journal.

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

## Process, lock, and service ownership

- The direct POSIX backend launches each Pi worker in an isolated process group; eviction,
  protocol-boundary failure, and shutdown signal that group. Pi's Bash tools create separate groups,
  which Pi cleans up during cooperative exit; a killed Pi cannot perform that cleanup. The optional
  [[herdr-enhancement]] backend owns these detached descendants through a per-worker kernel scope,
  including hard termination and recovery. This does not add a systemd dependency to direct mode.
  Windows terminates the worker's descendant tree through `taskkill /T`, escalating
  with `/F` only for the existing hard-kill boundary and falling back to Node's direct child signal
  only when the operating-system tree command cannot complete. A tracked child already known to have
  exited never authorizes another numeric PID/PGID signal on any platform. POSIX group signalling
  stays adjacent to the live tracked-child observation; no post-exit group identity is inferred from
  its old PID. A stop still awaits real child exit and already-started tree operations, not a signal
  or pipe-close deadline. Native commands receiving copied Windows environments resolve SystemRoot
  case-insensitively. Repeated lookups of the current process share its immutable birth identity;
  foreign PIDs are always re-queried and failed self lookups remain retryable.

- Preference read/merge/rename writes are serialized both within one Host and across independent
  Host processes through the same bounded lock abstraction used by single-instance launch. Linux
  uses kernel `flock`; macOS and Windows use an atomically published ticket queue whose owner
  records include the process birth identity and are reclaimed only after that exact process is
  gone. Field-scoped patches from different processes therefore cannot silently restore stale values
  for unrelated fields.

- The host binds only to loopback and does not directly expose unrestricted Pi control to another
  machine. Automatic desktop-browser opening is best-effort: a missing or failed OS opener is
  diagnosed but never terminates the already-listening Host. Optional [[connection-modules]] own
  only their local companion-process lifecycle and ingress path; they never become Pi/data authority
  or own host shutdown. Forwarded protocol is trusted only from a loopback hop. Production launch is
  single-instance and idempotent per checkout/host/port. Reuse requires matching private state and
  a fresh authenticated HTTP readiness result. Case aliases are verified against the actual native
  directory identity, not an OS-wide lowercase assumption; distinct case-sensitive roots remain
  distinct even on Windows.

  The local HTTP control protocol binds each request and response to the published installation,
  address, mode, process birth and startup incarnation. Domain-separated HMACs authenticate a fresh
  nonce, action, deadline and payload without sending the reusable Host token. Readiness,
  pairing-transfer issuance and maintenance prepare/commit/release use this protocol. One-use requests
  expire within 15 seconds,
  live replay records are bounded at 1,024, and request/response bodies are bounded at 2 KiB. The client
  rejects unsigned/mismatched replies, redirects, oversized bodies and expired results even when an
  overdue abort timer has not yet run. Only the Host's own ready publication can sign replies.
  Older unprovable Hosts are not silently treated as healthy.

  Managed shutdown has an HTTP-independent local control capability:
  bounded atomic request/result files beside instance state, authenticated with domain-separated
  HMACs using the existing private Host authority without serializing its token. Requests expire and
  bind root, address, mode, process birth and startup incarnation. Old, forged or foreign requests
  cannot stop a replacement or another instance.

  The Host retains its cooperative control loop if HTTP stops listening. It runs the same application,
  owned-worker and backend cleanup as ordinary shutdown and signs the outcome before exiting. CLI
  replacement requires both a clean authenticated result and confirmed OS process exit; state-file
  disappearance or a result alone is insufficient. Failed/unknown cleanup and a blocked event loop
  do not authorize PID killing or replacement. The launcher lease still fences handoff.

  Network shutdown sends normal WebSocket close notifications before runtime teardown. After the
  existing event-loop drain opportunity, it terminates remaining upgraded connections, including
  pre-attach and already-closing sockets; a missing browser acknowledgement cannot hold Host exit
  until the WebSocket library's close-handshake timeout. Wait for endpoint close callbacks, including
  terminal detach, before closing their service clients. This network fence does not replace
  owned-worker or PTY exit confirmation.

  A stop racing dependency installation or build cancels that pending start. Hosts predating the
  HTTP protocol can still use their advertised authenticated shutdown mailbox. No automatic CLI
  path falls back to sending the Host bearer over HTTP, even after a separate readiness proof:
  another connection can reach a replacement listener. Legacy Linux may stop only after `/proc`
  verifies exact birth, cwd and command line. Other legacy Hosts without cooperative controls need
  their existing service/inspected process controls for the one-time upgrade and otherwise fail
  closed. An unknown port occupant is never killed automatically. A source build and the launcher share one hash of browser-build inputs: an ordinary
  successful `build:web` writes a source-checkout stamp, a changed input forces exactly one
  replacement build, and a current stamp avoids redundant rebuilding before startup. The stamp is
  excluded from the npm distribution, whose launcher uses its packaged build directly.

  Launcher lock ownership is explicit and scoped: `restart` retains exactly one lock from its stop
  boundary through the replacement start, including when no managed instance existed, while
  standalone `stop` releases any lock before every return. Each browser-bound runtime event has an
  encoded-size ceiling, a joining WebSocket has a bounded pre-snapshot event backlog, and an
  established slow client is closed once its outbound buffer crosses the host limit; reconnecting
  obtains a fresh authoritative snapshot instead of retaining unbounded deltas.

- A matching installed `inspire-host.service` is the lifecycle authority for that checkout: ordinary
  `./inspire`, `status`, `stop`, and `restart` delegate only after its fragment path, working
  directory, `ExecStart`, and authenticated readiness hook identify the same root. Service
  activation completes only after that hook authenticates the Host readiness result, and ordinary status
  additionally requires the live authenticated Host rather than treating an active process as
  availability. The unit's own `ExecStart` bypasses delegation so it cannot recurse; explicit
  alternate-instance inputs and checkouts without the unit retain direct-launcher behavior.
  Instance selection compares the effective host, port, and state path with the installed default;
  merely inheriting those same values does not bypass its service manager. An explicit credential
  delegates only after authenticating the same running instance and matching that credential.
  A foreign or outdated installed unit still fails closed, rather than falling back to reparenting
  the same Host. Installing the host also installs an optional 04:00 user timer, but enabling the
  Host does not enable that timer. Scheduled maintenance requires separate operator opt-in;
  disabling the Host also stops/disables its timer so it cannot restart a disabled service.

  The timer never fetches updates: it restarts only if the installed external Pi version or a clean
  source revision differs from the running identity, Inspire-owned workers have no active
  run/dialog/queue, and no Host operation is in flight. Independently running external Pi does not
  block maintenance; a Host submission to it still does. A busy, dirty, indeterminate, or old Host
  is skipped without force or same-day retry.

  Scheduled restart uses an authenticated, single-owner prepare/commit handoff, not a boolean idle
  check. `POST /api/maintenance/restart` grants a unique, opaque `leaseId` and a 30-second `expiresAt`;
  this preparation blocks new work but does not authorize restart. After all systemd ownership
  inspections, the runner submits that exact identity to `/api/maintenance/restart/commit`. The Host
  synchronously validates the current, unexpired preparing lease and idle runtime, then commits the
  drain before responding. Only the matching `committed` response authorizes one external restart.
  Expired, released, foreign, previous-Host, and duplicate commits cannot authorize another restart.
  A preparation can expire and reopen admission; a committed drain **never auto-expires**, even if
  the external command or its caller is delayed beyond the preparation deadline.

  The lease owner does not retry commit or consume a late response after timeout. Before restart
  issuance, cancellation, failed inspection, or a lost commit response triggers owner-bound
  `/api/maintenance/restart/release` with the same `leaseId`. Release invalidates the identity, so a
  reordered commit cannot restore authorization. A proven failure to spawn systemctl permits the
  same release. An exit failure, signal, or lost result after command issuance does not prove that
  systemd rejected the restart: the runner reports recovery required and retains the committed
  drain. Lost release acknowledgement is also reported conservatively. Owner identities are neither
  logged nor persisted by the runner; admission diagnostics contain no lease capabilities.

  Recovery deliberately favors safety over automatic availability. If the runner dies or the
  restart outcome is unknown, do not reopen admission merely because time passed, the runner exited,
  or the service currently appears active. First establish that the lease owner cannot later issue
  its command **and** that no submitted systemd restart job can still execute. Only then may a
  retained owner explicitly release its lease, or an operator perform a separately authorized Host
  replacement to clear the in-memory drain when the owner identity is lost. Do not replace the Host
  and admit work while an old runner/job can still restart that replacement. This is a bounded
  maintenance handoff, not a durable transaction across independent/manual Host replacements.

## Explicit restart controls

### Scope and preparation

- `inspire restart` prepares dependencies/client build and imports the next runtime and external
  Pi SDK before stopping the Host. Preparation failure leaves it running. Host-only restart
  preserves the independent terminal daemon.
- `inspire restart --all` requires this installation's verified Linux systemd Host and terminal
  units. It ends terminal processes and restarts both in one transaction, with Host ordered after
  terminal readiness. Unsupported or foreign services are refused before stopping anything;
  connection services are outside the scope, and a failed full restart cannot fall back to Host-only.
- Page controls live in Settings → System, with concise confirmation for each scope. Ordinary
  Restart Host supports launcher-owned native Windows, macOS, and Linux instances, including custom
  loopback addresses, ports, and state paths. Installed Linux services retain their exact running
  systemd invocation as authority. A raw Host entrypoint without either owner cannot restart itself.
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
- A workload refusal offers a separate confirmed **Stop work and restart** under the same scope.
  The new operation authorizes interrupting Inspire-owned Pi work and discarding Pending input.
  Connected external Pi keeps running. It bypasses
  workload checks, including active compaction and session operations, while retaining preparation,
  service ownership, lease exclusivity, and final commit. Automatic maintenance stays update/idle-gated
  and Host-only.

### Submission and recovery

- Recheck the live launcher channel or current service invocation before committing the non-expiring
  drain and submitting the restart. The existing Host shutdown retires its workers. Proven
  non-issuance releases admission; uncertain submission retains the drain and reports recovery
  required. A lost launcher acceptance cannot trigger shutdown from a late reply or turn a later
  normal exit into a restart.
- The browser persists identity in tab-session storage before POST; invalid or unavailable storage
  blocks dispatch, not read-only Host observation. Recheck retries local recovery and clears the
  browser's blocked state once storage recovers. Explicit retry keeps the same identity.
  **Clear local restart record…** requires confirmation and discards only browser tracking; it neither
  sends nor cancels a restart. The Host's pending operation continues to fence new admission.
  Failed local cleanup preserves the record and reports a storage problem, not an unknown restart.
  A rejected receipt is labelled **last attempt**, because it is historical rather than a current
  busy check.
- The CLI checks readiness after restart; the browser reports reconnection to a new Host. Preflight
  checks dependencies, build, and imports in its execution environment.

## Atomic browser-build publication

- Ordinary source builds serialize publication per installation, stage Vite output away from the
  live `dist`, snapshot the outgoing build's complete content-addressed JavaScript, CSS, and
  WebAssembly generation, publish new hashed assets before switching `index.html`, and keep that one
  outgoing executable generation beside the new files during the Host handoff; clean release
  packaging exactly mirrors staged output and omits that outgoing generation from the artifact after
  archiving it. A production Host also registers the active generation in an installation-scoped
  user cache before accepting browser traffic.

  The active `dist/assets` always wins, while complete prior generations remain available for seven
  days under a 64 MiB stale-asset ceiling so an already-open page can perform its first deferred
  import after a rebuild or package replacement without reloading and losing browser-local work.
  Generations are evicted only as units, and a locked stale generation defers its own cleanup
  without disabling retained ones. Missing `/assets/*` paths return an actual `404` and can never
  fall through to the SPA document or poison the Service Worker cache with HTML under a module URL.
  Cache preparation failure is reported but does not prevent the current build from starting.

## Diagnostics

- Projection and RPC diagnostics are durable enough to explain an ownership rejection after the
  fact. A private rotated JSONL log correlates host id, slot incarnation, session/worker/PID, RPC
  id/type/timing, projection revision/fingerprint/identity/bytes, persistence expectation
  transitions, ownership-decision reason, and an opaque incident id shown in conflict UI. Logging is
  metadata-only: prompts, message text, tool results, extension payloads, credentials, tokens,
  absolute working directories, and raw child stderr are excluded. POSIX directories/files are
  `0700`/`0600`; Windows uses the current user-profile ACL boundary. A configured path is accepted
  only inside an existing private current-user directory.

- The mock host is a deterministic presentation fixture, not a second Pi implementation or
  runtime-conformance oracle; security and lifecycle guarantees are witnessed against
  `RuntimeController` and `PiRpcProcess` directly. Browser acceptance pins a bounded mock stream
  cadence and one worker so delivery controls are observed without overlapping prompts through the
  shared mock projection.
