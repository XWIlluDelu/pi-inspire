# Platform compatibility

## Explicit restart controls

### Contract and implementation

[[host-lifecycle]] keeps ordinary and scheduled restart Host-only. Full restart is explicit (`inspire
restart --all` or Settings → Updates → Restart all), requires installed Linux services, and ends
terminal processes. Confirmations remain concise, with no always-visible or command-palette control.

`inspire.mjs` runs dependency/client-build preparation and `server/restart-preflight.ts` imports
runtime modules plus the external Pi SDK before any stop. This probe does not open sessions, run
extensions, bind a Host, or attach to a terminal. Browser preparation inherits the running Host's
environment; bounded subprocess diagnostics expose preparation failures without stopping it.

`HostRestartController` owns one active intent and up to 32 retained identities per Host incarnation.
Preparation precedes a fresh runtime idle reservation. `requestBrowserRestart` rechecks exact unit
and invocation ownership before committing the existing non-expiring drain. Systemd receives a
single full-restart transaction, with Host ordered after terminal startup. There is no full-to-Host-only
fallback and no connection-service restart. Unknown submission retains the drain; it is not a refusal.

The browser persists delivery identity before POST, restores it on reload, rechecks read-only, and
retries only the same identity explicitly. A new Host retires that old identity without claiming that
all terminal work restarted successfully. Current authoritative preparation outranks old reconnection
notices. Concurrent status observers share an in-flight service inspection.

### Limits

No daily service was stopped or restarted, and no real conversation/terminal body was inspected.
Browser restart outcomes were intercepted synthetic API responses; installed service dispatch was
verified with fake systemctl, not a live remote restart. Local execution was Linux; Windows/macOS
page/full restart is deliberately unavailable, not claimed tested here.

Preflight is not a full boot rehearsal, immutable deployment, or rollback mechanism. Source can
change, CLI/service environments can differ, and ports or runtime startup can fail after preparation.
The CLI verifies systemd's readiness hook after restart; the browser observes a new Host rather than
asserting end-to-end tunnel or full-terminal success. A submitted operation that cannot be established
as unissued retains its drain and requires operator service recovery.

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
