---
purpose: Platform-specific mechanisms that affect launch, process ownership and terminal behavior.
---

# Platform compatibility

## Shell environment capture

Direct launches normally inherit the caller's environment; installed POSIX services capture the
selected shell's login/interactive exports once at startup. Selection, precedence and user controls
are in [[host-lifecycle]]; operational guidance is in
[Host operations](../../docs/host.md#shell-environment).

`server/user-environment.mjs` reads a uniquely marked JSON export from the shell's stdout pipe.
Shell startup can close auxiliary descriptors, so capture does not depend on inherited high FDs.
Startup output before the marker is discarded without counting toward the export limit. Success
requires a zero exit status and a valid bounded environment object. The Node parent enforces the
deadline by killing the isolated process group, independently of shell traps.
Errors describe the failure without exposing shell output or exported values.

The terminal daemon receives the captured environment explicitly. A later Host restart does not
change an existing PTY's environment. Linux service handoff is installation-scoped and private;
it does not mutate the systemd manager's global environment.

## Source-checkout handoff

A running source Host may load extension entrypoints when it starts a later worker. Preserve those
paths until the Host restarts, or prepare the new source in a separate directory. Preflight checks
the files it sees; it does not freeze a mutable checkout or protect a running Host from renamed files.

## File and process identity

Linux file locks use kernel flock. macOS and Windows publish process-birth-bound Lamport bakery
participants: a choosing file is atomically renamed to a numbered ticket before entry.
If a listed choosing file disappears before inspection, re-enumerate: the owner may still be live
under its ticket name. Both ticket selection and entry checks need this rescan to preserve exclusion.
A missing numbered ticket can mean release because that phase has no further rename.
See `server/file-lock.mjs` and `tests/portable/file-lock.test.mjs`.

Windows paths must pass through the correct platform URL-to-path rules. Preserve drive identity
for `file://` and `vscode://file/` references, and resolve directory aliases before comparing
export source and target identity. Windows rename and cleanup may require the relevant open handles
to close first.

Windows terminal logs use a read/write descriptor positioned at EOF. Append-only handles can refuse
truncate-to-tail even when ordinary appends succeed. Restored headless terminals use the same
options as live ones; otherwise old logs can accumulate during restoration.

Herdr scope cleanup opens the verified cgroup directory before killing or polling. A directory
removed after it is opened may return `ENODEV` rather than `ENOENT`; both mean that opened cgroup
is gone. Re-resolving a reused pathname would inspect the wrong owner. See [[herdr-enhancement]].

## PTY backends and command markers

The terminal uses `@lydell/node-pty` with prebuilt binaries. Windows selects bundled ConPTY through
`useConptyDll: true`; the operating system's backend can deliver OSC markers before their enclosed
text, breaking last-output copy. The selected package is a prerelease dependency, tracked in
`package.json`.

PowerShell emits its execution marker after `PSConsoleHostReadLine` returns the accepted command.
Wrapping the reader preserves PSReadLine bindings and multiline input. Rebinding Enter would mark
unfinished input as execution.

Bash 4.4+ provides `PS0`. Older Bash uses a top-level DEBUG event composed with existing traps;
standalone subshell-only lists may provide no such event and therefore no copyable output range.
Bash 5.1+ supports array-valued `PROMPT_COMMAND`; earlier versions need newline-separated shell
commands while retaining the original exit status.

Close and restart wait for confirmed PTY exit. Windows kill calls take no POSIX signal argument.
Interactive Bash exposes process-exit behavior that a non-interactive command may miss, so native
terminal checks need a real interactive shell as well as mocked transport coverage.

Native test fixtures use `tests/server/fixtures/isolated-environment.ts` to replace Windows
variables case-insensitively while preserving inherited key spelling. Adding `PATH` beside an erased
`Path` can hide the intended override because Node deduplicates keys before dropping undefined values.

Relevant suites: `tests/server/terminal-*.test.ts`, `tests/portable/`,
`tests/deploy/systemd-control.test.mjs` and `tests/launcher.test.ts`.
