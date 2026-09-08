---
purpose: "The loopback Host retains authenticated ingress, process and deployment ownership, safe build publication, and externally installed Pi authority across supported platforms."
covers:
  - inspire
  - deploy/systemd/**
  - scripts/{build-release,build-web,source-build-hash,write-build-stamp,verify-release-package,web-build-output}.mjs
  - server/{app,index,pi-rpc,pi-installation,preferences,access-token}.ts
  - server/runtime-event-sockets.ts
  - server/{file-lock,static-asset-cache}.mjs
  - server/*diagnostic*.ts
  - tests/launcher.test.ts
  - tests/portable/**
  - tests/server/{app,access-token,pi-installation,pi-rpc,static-asset-cache}.test.ts
---

# Host lifecycle, pairing, and distribution

## Goal

Launch, pair, package, diagnose, and stop one trusted local Host without exposing credentials or
making deployment machinery a second Pi runtime. Typed runtime integration is specified in
[[pi-integration]]; optional ingress is specified in [[connection-modules]].

## Checks

### Runtime installation and release packaging

- INSΠRE targets the latest Pi release. Pi's coding-agent and TUI packages are pinned exactly as
  deterministic development witnesses for type-checking, browser bundling, and installed-Pi
  integration suites; that checkout copy does not become a production runtime authority. Older Pi
  versions may remain incidentally usable but are neither tested nor supported, and no compatibility
  branch is added solely for them. Optional capabilities beyond the current public protocol remain
  inactive unless explicitly negotiated; absence follows current public behavior rather than version
  guessing. The production dependency tree resolves with zero `npm audit --omit=dev` advisories; no
  root override or downgrade is used to manufacture that result.

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

### Pairing and authenticated ingress

- Browser authentication is a one-time pairing, not an absent loopback boundary. Without an explicit
  `INSPIRE_TOKEN`, the host creates one 64-character base64url token (48 cryptographic random bytes)
  keyed by checkout/host/port under the user state directory, requires its containing directory and
  file to be current-user private (`0700`/`0600`), and reuses it across ordinary host and machine
  restarts. Prior generated token lengths rotate on the next host start. A direct loopback launcher
  URL or the Pair form proves that token once and receives an origin-scoped `HttpOnly;
  SameSite=Strict` cookie; a trusted loopback HTTPS proxy strips token URLs without pairing, emits
  `Secure` cookies through Pair, and authenticates WebSockets only by that cookie.

  A forwarded query token neither authenticates the socket nor vetoes an independently valid cookie.
  The bootstrap bearer is removed from browser history, retired from browser memory after it
  establishes the cookie, and never enters durable JavaScript storage. APIs require the cookie or an
  explicit bearer; WebSockets permit an explicit query bearer only on direct loopback, and all
  browser requests retain the exact-origin check. An invalid cookie is expired only for that Host
  origin so a rotated token returns to Pair without requiring broad browser-data deletion. A
  noninteractive host service suppresses token-bearing startup output so it is not written to the
  service journal. A missing or rotated token returns to the pairing surface rather than retrying as
  a connectivity failure.

- Browser pairing cookies are qualified by the normalized request host and port. Multiple Inspire
  hosts on one browser hostname therefore keep independent credentials instead of overwriting one
  shared cookie name; cookie lookup accepts only that origin-specific name.

### Process, lock, and service ownership

- On POSIX, each Pi worker and the tools it launches share an isolated process group; eviction,
  protocol-boundary failure, and shutdown signal the whole group so tool descendants cannot outlive
  their worker. Windows terminates the worker's descendant tree through `taskkill /T`, escalating
  with `/F` only for the existing hard-kill boundary and falling back to Node's direct child signal
  only when the operating-system tree command cannot complete.

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
  single-instance and idempotent per checkout/host/port: reuse and ordinary shutdown require the
  matching private state plus an authenticated Host response; Linux alone may fall back for an
  unhealthy Host after `/proc` verifies the exact process start, working directory, and command
  line.

  A stop racing dependency installation or build cancels that pending start, macOS and Windows fail
  closed when authenticated shutdown is unavailable, and an unknown port occupant is never killed
  automatically. A source build and the launcher share one hash of browser-build inputs: an ordinary
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
  activation completes only after that hook reaches the Host health endpoint, and ordinary status
  additionally requires the live authenticated Host rather than treating an active process as
  availability. The unit's own `ExecStart` bypasses delegation so it cannot recurse; explicit
  alternate-instance inputs and checkouts without the unit retain direct-launcher behavior.
  Installing the host also installs its attached 04:00 user timer, and enabling/disabling the host
  enables/disables that timer in the same command.

  The timer never fetches updates: it restarts only if the installed external Pi version or a clean
  source revision differs from the running identity, every runtime slot has no active
  run/dialog/queue, and the host atomically grants a 30-second no-new-work lease. A busy, dirty,
  indeterminate, or old host is skipped without force or same-day retry.

### Atomic browser-build publication

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

### Diagnostics and verification boundaries

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
