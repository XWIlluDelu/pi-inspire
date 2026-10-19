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

Workspace containment cannot use `win32.relative` alone: it folds case even when an NTFS directory
is case-sensitive. `server/filesystem-containment.ts` keeps canonical segment prefixes fast and uses
live directory identity only for plausible spelling/Unicode aliases. Similarity merely selects a
candidate; the same directory object must prove authority. Files, preview capabilities, project
references/configuration and installed package entries share this boundary while retaining their
file-handle and version rechecks. These live dev/inode comparisons are not cross-restart volume IDs.

Windows terminal logs use a read/write descriptor positioned at EOF. Append-only handles can refuse
truncate-to-tail even when ordinary appends succeed. Restored headless terminals use the same
options as live ones; otherwise old logs can accumulate during restoration.

Configuration edit locks distinguish a regular file's native target from a final symlink's separate
lexical and target authorities. Locking differently cased aliases of the same regular file twice can
self-conflict on a case-insensitive volume. `server/configuration-edit-locks.ts` takes only its target
lock while preserving both for symlinks and creation; it neither merges hardlinks by inode nor
lowercases paths. Both editors still recheck target/revision before publishing. Native case-alias
saves run only when the actual test volume supports them. See [[mcp]] and [[model-settings]].

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

Bash ignores rcfile/init-file injection for a genuine login shell, even with noprofile. Replaying
profiles from a non-login shell cannot restore login_shell or native .bash_logout. Login integration
therefore uses an inherited first-prompt bootstrap without changing HOME/ENV or feeding stdin.
User startup can replace/lock PROMPT_COMMAND; marker loss then means ordinary PTY operation, not
permission to override user initialization. Non-login shells keep native bashrc semantics.

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

Fake-worker fixtures substitute only their volume-identity adapter, not the actual Host platform,
locks, process birth or durable registration. Their scans stay within owned roots. Wait for lifecycle
signals rather than treating a one-second poll as the protocol deadline. Loading-state fixtures hold
the explicit action, not an assumed ordinal initial request. Native clipboard comparisons retain all
text/lines while accounting for Windows CRLF.

Mixed native font stacks expose box-centering errors that may be invisible with another platform's
fonts. Prompt navigation aligns text by its shared baseline and centers the neighboring SVG separately;
it does not use OS-specific pixel offsets or change the virtual row height.

Relevant suites: `tests/server/terminal-*.test.ts`, `tests/portable/`,
`tests/deploy/systemd-control.test.mjs` and `tests/launcher.test.ts`.
