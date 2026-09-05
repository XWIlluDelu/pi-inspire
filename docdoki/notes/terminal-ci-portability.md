---
purpose: Keep terminal tests portable to the Node 22 CI baseline and preserve truthful exit acknowledgement across the daemon and Host.
---

# Terminal CI portability

## Match the supported runtime

`.github/workflows/ci.yml` runs Node 22 on Ubuntu, macOS, and Windows, including packaged-Host smoke checks on main. A green Linux/Node 26 run is not evidence for that matrix. Verify `node --version` after selecting Node 22, then run `npm run ci` and `npm run release:verify`; follow the pushed commit's workflow through completion.

## Isolate the intended test boundary

- In `tests/web/terminal-connection.test.ts`, jsdom can enqueue zero-delay storage events when the connection writes its owner token. Under Node 22 those timers appear in the fake clock. Settle DOM events before stopping the connection, then retain the zero-timer assertion and advance another minute to prove no reconnect occurs. Clearing all timers would hide actual transport leaks.
- Shell-integration expectations must use platform path construction while still checking complete arguments and shell quoting. Do not weaken them to filename-only substring assertions.
- The POSIX descendant-cleanup fixture in `tests/server/terminal-session-manager.test.ts` launches its script through shell argv rather than racing interactive input against PTY initialization. The child publishes its PID only after ignoring SIGHUP. Cleanup must still prove that the previously live child disappears; startup failure is not evidence of failed process-tree termination.

## Process termination is not PTY exit acknowledgement

In the pinned `@lydell/node-pty` 1.1.0 implementation, `WindowsPtyAgent._flushDataAndCleanUp` uses a one-second output-drain interval before closing the output socket. A one-second Host-side wait can race this legitimate drain. `WindowsTerminal.kill` also rejects nonempty POSIX signal arguments, including when a deferred kill is finally executed.

`server/terminal-session-manager.ts` therefore retains the two-second graceful-stop window, allows five seconds for hard-stop exit acknowledgement, and clears the wait timer on either result. Windows taskkill failure falls back to native `pty.kill()` without a POSIX signal. The manager still requires the PTY's exit event: timeout returns `terminal_stop_timeout` and retains the terminal instead of pretending it was removed or restarting over it.

`server/terminal-daemon-client.ts` gives only remove/restart RPCs a fifteen-second budget, covering process-tree termination, graceful stop, and PTY drain. Ordinary catalog/control RPCs remain bounded at five seconds. Extending only the daemon's wait would let the Host time out before receiving the authoritative lifecycle result.

## Regression evidence

- Session-manager tests exercise delayed exit for force and graceful-then-hard termination, timer disposal, preservation of genuinely unresponsive terminals, and the native fallback on the current platform.
- Daemon tests use authenticated real IPC with a controlled clock. Remove and restart both complete after a six-second stop/drain sequence without the Host's former five-second deadline firing.
- Those delayed-exit and IPC regressions fail against the former one-second PTY/five-second RPC implementation. macOS process handling and the real Windows ConPTY backend still require their native CI jobs; a fake PTY on Linux is not a substitute.
