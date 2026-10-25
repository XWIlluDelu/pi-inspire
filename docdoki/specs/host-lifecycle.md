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

The support baseline follows [[northstar]]. Windows native operations require PowerShell 7 from
named PATH locations or the standard Program Files installation; missing PowerShell is a dependency
failure, with no legacy-engine fallback.

## Runtime installation and release packaging

- Target the latest Pi release, with exactly pinned coding-agent/TUI development dependencies for
  typechecking, bundling and integration checks. Production uses external Pi; older versions have
  no maintained compatibility branches. Additional protocol capabilities require explicit
  negotiation; missing capabilities follow current public behavior.
  Production releases require zero `npm audit --omit=dev` advisories, without overrides or downgrades
  that conceal an affected dependency. [[dependency-boundaries]] owns runtime selection and licensing.

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

  Send WebSocket close notifications before runtime teardown, then terminate remaining upgraded
  connections after the event-loop drain opportunity. Include pre-attach and already-closing peers
  so a missing browser acknowledgement cannot hold Host exit until the library handshake timeout.
  Endpoint close callbacks, including terminal detach, precede service-client close; owned-worker
  and PTY exit still require separate confirmation.

  A stop racing dependency installation or build cancels that pending start. Hosts predating the
  HTTP protocol can still use their advertised authenticated shutdown mailbox. No automatic CLI
  path falls back to sending the Host bearer over HTTP, even after a separate readiness proof:
  another connection can reach a replacement listener. Legacy Linux may stop only after `/proc`
  verifies exact birth, cwd and command line. Other legacy Hosts without cooperative controls need
  their existing service/inspected process controls for the one-time upgrade and otherwise fail
  closed. An unknown port occupant is never killed automatically.

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

  Scheduled restart uses an authenticated, single-owner prepare/commit handoff:

  1. `POST /api/maintenance/restart` grants an opaque `leaseId` and 30-second `expiresAt`.
     Preparation blocks new work but does not authorize restart. After systemd ownership checks,
     `/api/maintenance/restart/commit` validates that current, unexpired lease and idle runtime,
     then synchronously commits the drain. Only its matching `committed` response authorizes one
     external restart; duplicate, expired, released, foreign and previous-Host leases cannot do so.
     Preparation may expire and reopen admission; a committed drain never auto-expires.
  2. Do not retry commit or consume a late response after timeout. Before command issuance,
     cancellation, failed inspection or a lost commit response triggers owner-bound
     `/api/maintenance/restart/release`. Release invalidates the identity, including reordered
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
- The CLI checks readiness after restart; the browser reports reconnection to a new Host.

## Atomic browser-build publication

- Source builds and the launcher share one browser-input hash. Successful `build:web` writes a
  checkout stamp from the inputs sampled before compilation; saving changed inputs during a build
  leaves that stamp stale so the next launch rebuilds. A current stamp avoids rebuilding at startup.
  The npm distribution omits the stamp and uses its packaged build.

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

- The mock Host is a deterministic presentation fixture. Runtime/security/lifecycle checks use
  `RuntimeController` and `PiRpcProcess` directly. Browser acceptance uses bounded mock delivery
  and one worker to avoid overlapping prompts through its shared projection.
