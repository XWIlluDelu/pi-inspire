---
purpose: Platform-specific launch, file/reference identity, process ownership and native browser input.
---

# Platform compatibility

## Platform-specific input

[[northstar]] defines platform priorities and [[host-lifecycle]] defines runtime prerequisites.
PowerShell helpers qualify their built-in modules so they work in a cold shell environment.

On iPhone, focusing small-font inputs can zoom the viewport independently of window width.
The sidebar has a local editing exception. Composer retains all saved content-size choices.
`tests/browser/responsive-inputs.spec.ts` exercises path, search and picker controls in
Chromium and Firefox. Synthetic composition checks exercise the shared IME guards; hardware
keyboard and OS input-method behavior require device checks.

## Verified native baseline

[CI run 39574685523](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39574685523) passed all
seven jobs for [v0.6.0](https://github.com/XWIlluDelu/pi-inspire/tree/v0.6.0)
(`f67d6eef659ca4500bf39167c8460813d5d2a85d`), including installed-package checks on Linux, macOS
and Windows. The [v0.6.5 release run](https://github.com/XWIlluDelu/pi-inspire/actions/runs/40339358680)
failed at its tag. A later `auto-dev` revision (`2fe2dc73`) passed all seven jobs in
[run 40481436169](https://github.com/XWIlluDelu/pi-inspire/actions/runs/40481436169).
[[follow-runtime-quality-2026-10-25]] records the separate v0.6.5 Linux production-install check.

Package checks exercise default-daemon PTY I/O, terminal maintenance, Host restart preserving
terminals, authenticated readiness/pairing and session recovery. Native shell/filesystem checks
and simulated Win32 contracts provide separate evidence.

## CI verification scope

[CI](../../.github/workflows/ci.yml) runs the full matrix on main pushes. Pull requests omit
installed-package verification, and `auto-dev` pushes require manual dispatch.

| Dispatch scope | Checks |
| --- | --- |
| `checks` (default) | Ubuntu `npm run check`. |
| `windows-core`, `macos-core` | Build, portable and unit/integration checks, native Trash/recovery and launcher on the named OS. |
| `windows`, `macos` | Named OS core and Chromium. macOS also runs WebKit. |
| `full` | Complete matrix, with all three installed-package checks and size report. |

```sh
gh workflow run ci.yml --ref auto-dev -f scope=windows-core
```

Dispatch on `auto-dev` and PR runs supersede older runs within the same workflow, ref and scope.
Main and other refs keep each run.

Opt portable browser flows into all engines with `@cross-browser`. Mark OS-sensitive UI cases
with `@platform-ui` for targeted native Chromium runs. Block Service Workers where interception
must reach a test route. Keep real PTY, upload, download and clipboard checks on their native
transports. Clipboard observers record only successful browser writes. Use Tab for focus-visible
geometry and wait for lifecycle signals or explicit actions instead of request ordinals or polling
deadlines.

## Git and native file representation

Read-only Git inspection preserves repository, worktree and submodule configuration precedence.
Passing the root's effective settings to `-c` would override child-local EOL settings and falsely
report dirty submodules. Native Git tests cover this precedence, protected trust resets and
converter execution. See [[resource-preview#Git Changes]] for scope.

Filesystem fields use `fileResourceReference`; prose and diagnostic locations use their own
adapter. The resolver parses locations before decoding URLs once, preserving literal `%20` and
hash filenames alongside encoded URLs. `tests/server/resource-reference-identity.test.ts` checks
their distinct identities. Portable fixtures normalize Host document separators while checking
native paths separately.

Preview tests cover UTF-8 and both UTF-16 byte orders with BOMs, bounded decoding at code-point
boundaries, and real Unicode files. Download checks compare original bytes, independently of
preview encoding.

## Development launch and terminal input

Development launch contracts and usage are in [[host-lifecycle#Development launch]] and
[Host operations](../../docs/host.md#development-checkout).

Node's supported `--watch` with the `tsx` import loader is the source watch entry. A
[Windows comparison](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39289400767) found that
`tsx watch` never published Host state while native watch completed the same startup contract.

[Native Windows checks](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39290568686) pass 110
startup/authentication/keyboard cases and two real-xterm Chromium cases; macOS rechecks all three
development startup cases. The [macOS input run](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39288350835)
passes 110 cases, two Chromium cases and two WebKit cases. Browser cases use no retries. A separate
real development page completed one-use pairing, session opening and authenticated reload.

The xterm cases check clipboard modifiers, selected/unselected interrupt bytes and palette focus
without PTY leakage. [[terminal]] owns the keyboard and modal contracts.

## Shell environment capture

`server/user-environment.mjs` reads the marked export from stdout because shell startup can close
auxiliary descriptors. The parent discards output before the marker and enforces the deadline
independently of shell traps. See [[host-lifecycle#User execution environment]] for the capture
contract and [Host operations](../../docs/host.md#shell-environment) for configuration.

A running source Host can load extension files when it starts a later worker. Keep those paths
available until restart, or prepare the replacement in a separate checkout. Preflight sees only
the files present when it runs.

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
Case-insensitivity is a native filesystem property, not a blanket Windows rule. Redirected Windows
platform-directory exports keep case-insensitive lookup after copying into a plain object.

Windows terminal logs use a read/write descriptor positioned at EOF. Append-only handles can refuse
truncate-to-tail even when ordinary appends succeed. Restored headless terminals use the same
options as live ones; otherwise old logs can accumulate during restoration.

Configuration edit locks distinguish a regular file's native target from a final symlink's separate
lexical and target authorities. Locking differently cased aliases of the same regular file twice can
self-conflict on a case-insensitive volume. `server/configuration-file.ts` takes only its target
lock while preserving both for symlinks and creation; it neither merges hardlinks by inode nor
lowercases paths. Both editors still recheck target/revision before publishing. Native case-alias
saves run only when the actual test volume supports them. See [[mcp]] and [[model-settings]].

Herdr scope cleanup opens the verified cgroup directory before killing or polling. A directory
removed after it is opened may return `ENODEV` rather than `ENOENT`; both mean that opened cgroup
is gone. Re-resolving a reused pathname would inspect the wrong owner. See [[herdr-enhancement]].

## Host and terminal lifecycle evidence

A Host-shaped health response or numeric PID cannot identify the HTTP peer. Even a successful
proof on one connection cannot authorize sending a reusable bearer on the next connection after
port reuse. [[host-lifecycle#Instances and local control]] owns signed control. The installed
package and `tests/server/instance-control.test.ts` exercise the impostor-listener boundary.

Node's `closeAllConnections()` excludes upgraded sockets. Shutdown sweeps public
`WebSocketServer.clients` because business subscription sets may already have forgotten
pre-attach or closing peers. `tests/server/host-shutdown.integration.test.ts` injects closure,
drain failure and stalled exit through public Node hooks in an owned test Host. See
[[host-lifecycle#Shutdown]] for exit and acknowledgement rules.

Page restart needs tests against the direct launcher as well as systemd. For source installs,
Node's `--import tsx` loader keeps the tracked IPC child itself the Host. An extra wrapper can
hide that ownership. Native source checks preserve an independent terminal across restart, and
installed-package checks exercise page restart with an idle Pi worker and real daemon I/O.
[[host-lifecycle#Explicit restart controls]] defines the scopes. Pairing guidance offers installed
and source commands because the browser's OS does not identify the Host's OS.

On Linux, read parent and birth from one `/proc` stat. A vanished process can report `ESRCH`
as well as `ENOENT`. macOS checks descendants at its native `ps` birth precision. On Windows,
unproven numeric identity leaves [native ConPTY closure](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session#ending-the-pseudoconsole-session)
available. Exit and timeout cancel PTY-owned metadata subprocesses independently of Host identity
lookups. Tests include live HUP-resistant and detached children. [[terminal#Process ownership]]
defines retirement; [terminal maintenance](../../docs/host.md#terminal-service-maintenance) applies
daemon changes.

Local IPC address ownership alone cannot authenticate a peer. Terminal IPC uses Node's
certificate-free TLS 1.2 PSK/AES-GCM support. A pathname socket's final unlink belongs to the
listener close; a second unlink can remove its successor. Test the default socket address as well
as overrides, since native limits count bytes. Detached daemon tests exercise inherited systemd
notification/socket-activation variables. The current protocol and ownership are in
[[terminal#Process ownership]].

## Trash volumes and recovery

Native Windows and macOS Trash APIs consume the quarantine path; neither supplies a documented
arbitrary original-path override. A visible recovery folder therefore carries the exact JSONL,
original-path manifest and recovery instructions. `inspire recover-session` validates the copied
payload and publishes at the original physical path without overwriting an occupant. The digest
binds payload bytes across OS copy/restore operations where inode identity changes. It is not a
routine file-move checksum. See [[session-deletion]] and
[recovery operations](../../docs/host.md#recover-a-deleted-session).

Linux home Trash is only valid on the source mount. `server/linux-trash.ts` reads mountinfo plus
the opened directory's fdinfo mount ID, including bind/overmounted paths; longest-prefix and dev-only
guesses are insufficient. The native deletion adapter chooses validated home or volume-local
Freedesktop Trash while preserving its normal original-path restoration metadata.

Uploaded ordinary files are durable assets, independent of Trash and session-directory identity.
[[composer]] defines staging cleanup; [cleanup operations](../../docs/host.md#uploaded-file-retention-and-cleanup)
explains explicit delivered-file removal and mixed-version stores.

## Clipboard activation and native lookup

WebKit accepts short async reads but rejects a clipboard request first issued six seconds after the
click. Start one promise-backed ClipboardItem from the gesture, then resolve its declared formats
after every source and conversion validates. Visible source metadata includes omitted Pending rows;
older snapshots without it retain the read-first compatibility path. Explicit background-write
permission allows the existing reverse multi-image history writes. A newer clipboard action retires
pending reads globally; unmount/session/view/transport retirement retains its own cancellation.
`tests/browser/clipboard-gesture.spec.ts` exercises real text/PNG writes, delayed last-response Copy,
and retirement in Chromium, Firefox and WebKit.

Quoted Windows PATH entries can contain spaces and semicolons. Environment-name lookup stays
case-insensitive after copying `process.env` into a normal object; Pi discovery and terminal profiles
share `server/platform-environment.mjs`, including npm bootstrap and desktop openers. The plain-JS
module also runs before a source loader/dependencies are ready. File checks reject directories and
do not add cwd to PATH.
Windows home-relative paths accept either separator, UNC cwd markers remain absolute, and shifted
terminal shortcuts use physical key identity rather than assuming Shift preserves the key character.

## Native downloads and filesystem names

WebKit can omit both Origin and Fetch Metadata for attachment downloads. An anchor with
`rel=noreferrer` would also remove the final same-origin signal, so the authenticated native
download uses an origin-only referrer. Chromium, Firefox and WebKit verify large-file bytes
and one-use ticket replay rejection. See [[host-lifecycle#Pairing and authenticated ingress]].

Enumerate Windows drive names without statting each root. A disconnected mapping can hang and
should be touched only on navigation. Filter native-hidden entries before following symlinks and
junctions, so an invisible redirected target does not block browsing. Show-hidden retains link
traversal.

Multer's default filename charset can corrupt non-ASCII multipart filenames. [[composer]] owns
UTF-8 upload names, byte budgets for physical cache names and preservation of existing paths.

## PTY backends and command markers

The selected backend is `@lydell/node-pty@1.2.0-beta.15`, with prebuilt binaries. It avoids the
observed cleanup hang and Linux build requirements of upstream `node-pty@1.1.0`. Windows explicitly
uses bundled ConPTY (`useConptyDll: true`); the sampled win32-x64 payload is Microsoft ConPTY
`1.25.260303002-preview`. These are prerelease dependencies. The OS backend can deliver OSC markers
before enclosed text, breaking last-output copy; backend selection therefore affects correctness.

[[terminal#Process ownership]] defines native shell initialization and marker behavior. PowerShell
uses the accepted command from `PSConsoleHostReadLine`; rebinding Enter can mark unfinished
multiline input. Zsh must follow ZDOTDIR changes during startup. Bash ignores rcfile injection
for genuine login shells; a non-login shell replay cannot restore `login_shell` or native logout.
History-relative `fc` can choose the previous command during substitution. Older Bash DEBUG
hooks may miss a standalone subshell list, so no command-output range is reported for that case.
Native retirement tests use interactive shells, where exit behavior can differ from a single
non-interactive command.

Native test fixtures use `tests/server/fixtures/isolated-environment.ts` to replace Windows
variables case-insensitively while preserving inherited key spelling. Adding `PATH` beside an erased
`Path` can hide the intended override because Node deduplicates keys before dropping undefined values.

Native clipboard comparisons normalize Windows CRLF and preserve the remaining text.

Mixed native font stacks expose box-centering errors that may be invisible with another platform's
fonts. Prompt navigation aligns text by its shared baseline and centers the neighboring SVG separately;
it does not use OS-specific pixel offsets or change the virtual row height. Baseline estimates that
combine Range position and Canvas ascent allow one CSS px on every engine, because independently
rounded metrics do not establish half-pixel precision. Actual DOM columns, boundaries and padding
retain 0.5 px checks; this measurement distinction does not authorize product CSS compensation.

Relevant suites: `tests/server/terminal-*.test.ts`, `tests/portable/`,
`tests/deploy/systemd-control.test.mjs` and `tests/launcher.test.ts`.
