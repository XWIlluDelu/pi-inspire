# Platform compatibility

## Explicit restart controls

### Scope and preparation

The contract is in [[host-lifecycle]]. Host-only restart replaces Pi workers and preserves project
terminals. Restart all also ends terminal processes and requires this installation's Linux systemd
Host and terminal services. Scheduled maintenance remains Host-only and idle-gated.

`inspire.mjs` prepares dependencies and the client build; `server/restart-preflight.ts` imports the
next runtime and external Pi SDK before the current Host stops. Browser preparation uses the
running Host's environment. A preparation failure leaves it running.

### Restart admission

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
for operator recovery. [[state-ownership]] explains the owner-bound maintenance lease.
The CLI checks service readiness; the browser reports reconnection to a new Host.

### Failed-startup cleanup

A failed startup previously left `startupPhase = "starting"`; a startup dialog could also retain
an already-settled `startupStop` promise. Both looked like unfinished work after Pi had stopped.

`RuntimeWorkerLifecycle.stop` now returns startup to idle only after confirmed retirement. The
startup error latch interrupts a rejected handshake once, without a second stop promise. The
original failure remains available, while a pending or rejected stop continues to block ordinary
restart and replacement. A fresh request can succeed after cleanup; the old refusal stays unchanged.

### Source-checkout handoff

A running source Host can load extension entrypoints when it starts a later worker. Removing or
renaming a referenced file can therefore break new sessions before the Host restarts. Preserve
those paths through the handoff, or prepare the new source in a separate directory. Preflight
validates the files it sees; it does not freeze a mutable checkout for the running Host.

### Regression coverage

| Area | Evidence |
| --- | --- |
| CLI preparation and scope | `tests/restart-launcher.test.ts` checks failed preparation, scoped systemd submission, and flag validation in a packaged-runtime fixture. |
| Host admission and identity | `tests/server/host-restart*.test.ts` covers authentication, scope/permission mismatch, retained receipts, busy rejection, non-issuance, and unknown submission. |
| Browser recovery | `tests/web/host-restart*.test.{ts,tsx}` covers confirmation, storage, read-only recheck, retry identity, and Host replacement. |
| Service ownership | `tests/deploy/systemd-control.test.mjs` checks exact invocation, final commit ordering, and the full-restart transaction with synthetic systemctl. |
| Startup retirement | `tests/server/runtime.test.ts` covers pending and rejected stops; `tests/server/pi-startup-retirement.integration.test.ts` uses real Pi with temporary configuration for idle, missing-extension, and startup-dialog cases. |

## User execution environment

### Boundary and rationale

The user approved reusing their existing development environment alongside their external Pi
installation. The original systemd units reduced PATH to the bootstrap Node directory and system
bins. A normally installed CLI in `~/.local/bin` was consequently invisible to extension processes.
Separately, `inspire.mjs` and the terminal unit forced `NODE_ENV=production`, changing npm behavior in
user projects. These were launcher-environment problems, not reasons to customize individual tools.

`server/user-environment.mjs` resolves exports at the launcher boundary. Direct launches retain the
caller's environment; installed services use the user's selected login/interactive shell from their
home directory. The helper runs the current absolute Node executable only to serialize exports.
Runtime children receive the resolved result, with discovery consumed rather than recursively run.
The binding contract is in [[host-lifecycle]] and [[pi-integration]].

No second environment database or install-time credential snapshot is needed. Removing Inspire's
forced NODE_ENV preserves user provenance directly, including unset and empty values. Express sets
its production mode on its own application object. `INSPIRE_TERMINAL_IN_PROCESS`, not the user's
NODE_ENV, controls the special in-process terminal owner.

Independent terminal services need the same boundary. The installed terminal launcher resolves the
shell environment. The transient `systemd-run` path transfers named exports using `--setenv=NAME`
with the supplied subprocess environment, rather than including values in command arguments. The
new service receives systemd's own invocation/notification identity, not the Host's. Detached fallback
continues to inherit the supplied environment.

### Probe behavior and failure handling

- Supported shell initialization uses `-i -l -c`, not manually sourcing a particular rc file in a
  potentially different shell. `INSPIRE_SHELL` overrides SHELL/account selection; explicit inherit
  mode supports externally managed environments. This does not change Pi's native shell tools.
- Startup output is discarded, while exports use a separate pipe. The final command redirects its
  stdout to that pipe: interactive Bash did not reliably preserve an inherited auxiliary descriptor
  into Node, so writing directly to fd 3 failed in the initial experiment. Explicit descriptor
  duplication works with the tested Bash and Zsh initialization.
- The probe is isolated, limited to ten seconds and 1 MiB of exports, and killed as a process group
  on timeout/overflow/failure. Errors do not repeat shell output or environment values. No partial
  result or silently reduced PATH is accepted.
- Shell unsets are retained. Explicit Inspire controls and systemd identity survive initialization;
  temporary probe state does not. Interactive-only prompts/TUI startup can check
  `INSPIRE_RESOLVING_ENVIRONMENT=1` while leaving exports active.
- The result contains exported process state, not aliases/functions or a virtual environment from
  some other terminal tab. Existing terminal processes are not changed by a Host restart.

### Deployment boundary

Project changes do not rewrite the installed services, restart the active Host/terminal daemon,
change the user's shell files, modify Pi, or remove existing workaround symlinks. Existing terminal
unit files still force production until reinstalled. The documented migration is:

```sh
./inspire service install-host
./inspire restart --all
```

The second command ends project terminal processes and must be scheduled deliberately. Host-only
restart keeps those processes and their old environment. Remove any temporary tool symlink only
after verifying the newly started runtime's normal command lookup.

## Portable file-lock phase races

`server/file-lock.mjs` keeps Linux's established kernel-flock protocol. macOS and Windows instead publish process-birth-bound participants in a Lamport bakery: `choosing-<token>.json` is atomically renamed to `ticket-<number>-<token>.json` before entry to the critical section.

A directory listing and inspection of its entries are not one atomic observation. If a listed choosing file disappears before `lstat` or `readFile`, the owner may still be live under its ticket filename. Treating that `ENOENT` as departure admits two races:

1. **Ticket selection:** an entrant misses an existing ticket, picks the same number, and can sort ahead of an owner already inside its critical section.
2. **Entry check:** a scan misses a lower-priority-numbered ticket during its choosing-to-ticket rename and admits a second owner.

Both ticket selection and entry checking must re-enumerate after a missing choosing entry. Rescans stay within the caller's acquisition deadline. A missing numbered ticket can still mean release, since numbered participants are never renamed to another phase and tokens are not reused. Ownership verification and stale-owner cleanup remain process-birth/token/inode bound.

## Terminal CI portability

### Match the supported runtime

`.github/workflows/ci.yml` runs Node 22 on Ubuntu, macOS, and Windows, including packaged-Host smoke checks on main. A green Linux/Node 26 run is not evidence for that matrix. Verify `node --version` after selecting Node 22, then run `npm run ci` and `npm run release:verify`; follow the pushed commit's workflow through completion.

### Isolate the intended test boundary

- In `tests/web/terminal-connection.test.ts`, jsdom can enqueue zero-delay storage events when the connection writes its owner token. Under Node 22 those timers appear in the fake clock. Settle DOM events before stopping the connection, then retain the zero-timer assertion and advance another minute to prove no reconnect occurs. Clearing all timers would hide actual transport leaks.
- Shell-integration expectations must use platform path construction while still checking complete arguments and shell quoting. Do not weaken them to filename-only substring assertions.
- The POSIX descendant-cleanup fixture in `tests/server/terminal-session-manager.test.ts` launches its script through shell argv rather than racing interactive input against PTY initialization. The child publishes its PID only after ignoring SIGHUP. Cleanup must still prove that the previously live child disappears; startup failure is not evidence of failed process-tree termination.

### Process termination is not PTY exit acknowledgement

In the pinned `@lydell/node-pty` 1.1.0 implementation, `WindowsPtyAgent._flushDataAndCleanUp` uses a one-second output-drain interval before closing the output socket. A one-second Host-side wait can race this legitimate drain. `WindowsTerminal.kill` also rejects nonempty POSIX signal arguments, including when a deferred kill is finally executed.

`server/terminal-session-manager.ts` therefore retains the two-second graceful-stop window, allows five seconds for hard-stop exit acknowledgement, and clears the wait timer on either result. Windows taskkill failure falls back to native `pty.kill()` without a POSIX signal. The manager still requires the PTY's exit event: timeout returns `terminal_stop_timeout` and retains the terminal instead of pretending it was removed or restarting over it.

`server/terminal-daemon-client.ts` gives only remove/restart RPCs a fifteen-second budget, covering process-tree termination, graceful stop, and PTY drain. Ordinary catalog/control RPCs remain bounded at five seconds. Extending only the daemon's wait would let the Host time out before receiving the authoritative lifecycle result.
