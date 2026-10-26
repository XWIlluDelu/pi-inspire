---
purpose: Platform-specific launch, file/reference identity, process ownership and native browser input.
---

# Platform compatibility

## Runtime baseline

Target current supported systems and reasonably recent dependencies. Windows native helpers use
PowerShell 7; named PATH entries precede its standard Program Files installation, without an old
engine fallback. Internal scripts qualify their built-in modules rather than depending on broad
command auto-discovery in a cold user environment. macOS/POSIX shell regressions use the installed
shells, not forced additional historical binaries. Requirements and restricted-shell npm shim
commands are in [Host operations](../../docs/host.md).

## Verified native baseline

Recorded cross-platform release evidence includes [CI run 39574685523](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39574685523)
at `f67d6ee` (v0.6.0): all seven jobs pass, including Linux/macOS/Windows and three installed-package
checks. [[follow-release-0-6-0-2026-10-21]] owns that release record;
[[follow-project-quality-2026-10-21]] records subsequent integration checks.
[[follow-runtime-quality-2026-10-25]] records local Linux production-install verification for 0.6.5.

Package checks exercise a real default daemon, PTY I/O, terminal maintenance, Host restart preserving
terminals, authenticated readiness/pairing and native session recovery. Native filesystem/shell checks
and simulated Win32 contracts provide separate evidence. Browser-generated IME events establish event
handling, while physical keyboard/IME behavior still requires device testing.

The earlier [full matrix at `681f694`](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39275088788)
includes failures and retries. The [focused fixture correction](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39282788430)
passes 26 branch and three Chromium cases on Windows/macOS, plus two macOS WebKit shortcut cases,
without retries. Its reusable lessons are to preserve Host-normalized document separators while
asserting raw paths separately, and to block Service Workers in mock-routing suites. It does not
change the original full run's result.

## Windows full-suite completion

The [integrated run](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39293720205) passes Linux,
macOS and package checks but leaves two Windows integration failures and an interrupted browser phase.
On `6500af1` with fixture corrections, the [Windows completion](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39359339465)
passes Chromium (340 cases, one skip, zero retries), portable, native Trash/recovery and launcher
checks. After isolating a native-attribute fixture, [full unit completion](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39362531329)
passes 3,385 cases with 152 conditional skips; the completed browser suite is not repeated.

These corrections retain real files, corrupt-index and native-attribute coverage. Native Pi fixtures
start only their own worker and use its existing integration deadline; branch fixtures wait for
confirmation rather than a one-second poll. Focus-visible geometry uses real Tab navigation.
The sequential Windows CI job has a 60-minute aggregate budget so all phases can complete.

## Git, resource and input semantics

Read-only Git inspection keeps approved system/global data in a private short-lived global file,
preserving native repository, worktree and submodule-local precedence. Copying the root's effective
settings indiscriminately into `-c` would override child-local EOL settings and falsely report dirty
submodules. The native delta runs 25 real-Git configuration cases on both Windows and macOS, covering
EOL, attributes/ignores, protected trust resets, converter execution gates, missing-promisor objects,
machine patch grammar and private-file cleanup. Scope and unsupported contexts are in
[[resource-preview#Git Changes]].

Native scripts and project/property text share classification between indexing and resolution;
binary plist detection reads only the authorized descriptor. Reference parsing preserves UNC,
backslash-home and complete delimited/diagnostic paths. Shared IME guards respect both composition
state and the final key code 229; modal focus ownership also leaves IME Escape/Tab native. Component
and synthetic browser-event checks establish this event contract, not physical OS IME behavior.

Native filesystem fields use `fileResourceReference` before indexing, DOM controls or transport;
prose/code diagnostics use their separate adapter, and actual URLs keep link syntax. Resolution
parses locations before decoding once. Keys retain representation and URL authority; native labels
and exact workspace paths are never URL-decoded. This separates literal `%20` and space filenames,
hash directories and diagnostic-looking literal names without guessing from file existence.
`tests/server/resource-reference-identity.test.ts` and HTTP authority tests verify independent
external citations, bytes/downloads and compatible-revision reauthorization. Win32 contracts and
native runs cover drive, UNC and home paths; Host-normalized metadata supports document URL joins.

Authorized text previews decode UTF-8/UTF-16LE/UTF-16BE BOMs and otherwise use UTF-8, without guessing
legacy code pages. A bounded preview uses streaming decoding so a cut code point does not invent a
replacement character. Reconstructed HTML declares UTF-8; downloads retain the original file bytes.
Decoder/controller cases cover PowerShell, Markdown, notebooks, HTML and SVG, and browser cases read
real Unicode files and compare raw downloads.

Terminal tab shortcuts yield to third-level characters, ordinary editors and composition. Consumed
chords do not also reach the PTY. Mac Option is native by default, with an explicit browser-local
Meta option. Global model/thinking cycling uses Control+Command+M/P/R on Mac and produced-letter
Alt+Shift+M/P/R elsewhere. Matching and hints share one policy; native Option characters do not
become model actions.

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

## Local HTTP peer authentication

A Host-shaped health reply cannot identify the listener occupying a recorded port. Sending its
private bearer first leaks that authority to a replacement service. Merely checking PID first also
does not bind the socket to that process, and authenticating one connection does not secure a later
bearer request after port reuse.

`server/instance-control.mjs` instead authenticates action/payload-bound, expiring requests and
nonce/instance-bound replies. The Host signs its own current publication, and the token never crosses
these HTTP paths. [[host-lifecycle]] owns the protocol bounds and pairing/token-output rules.
Evidence lives in `tests/server/instance-control.test.ts`, the portable lifecycle test and the
installed-package impostor regression.

Case-insensitivity is a native filesystem property, not a blanket Windows rule. Root spelling
aliases require the same live directory identity when canonical strings differ; this does not
persist dev/inode numbers as cross-restart volume identity. Redirected Windows platform-directory
exports also retain case-insensitive lookup after copying into a plain object.

## Local Host shutdown authority

`server/instance-state.mjs` provides authenticated atomic request/result mailboxes independently
of HTTP. This lets a managed Host cleanly stop after its listener closes. [[host-lifecycle]] owns
identity, expiry, confirmed-exit and legacy-upgrade requirements.

WebSocket close notification is not a drain acknowledgement. Node's `closeAllConnections()`
excludes upgraded sockets, and a peer can leave `ws` waiting its default 30 seconds. The app sends
normal close frames and runs runtime teardown first, gives the existing event-loop opportunity, then
terminates the endpoints' remaining public `WebSocketServer.clients`. Business subscription sets
cannot authorize this sweep because they may already have forgotten closing/pre-attach peers.
Wait for the endpoints' actual close callbacks before closing service clients, so terminal detach
finishes first on every OS. Worker/PTY retirement remains a separate confirmed-exit requirement.

Linux can return `ESRCH` as well as `ENOENT` when a process disappears during a `/proc/<pid>/stat`
read. Herdr treats either as a missing leader, not numeric PID/group signal authority. Its retained
kernel-scope identity still authorizes scope cleanup and requires confirmed emptiness; permission
errors remain failures. See `server/herdr-process-group.ts` and the scope-retirement regressions.

`tests/server/host-shutdown.integration.test.ts` injects HTTP closure, drain failure and a stalled
process exit into owned source Hosts through a test-only preload using public Node Server hooks.
It does not add production debug routes or depend on inspector/private runtime APIs. The control
tests separately cover forgery, expiry, configuration/incarnation mismatch and private bounded I/O.

## Page restart ownership

Portable lifecycle coverage must exercise the page restart route as well as CLI start/status/stop:
service-only page fixtures can miss a native-launcher capability gap.

Ordinary page restart follows launch ownership. A direct launcher provides
private Node child IPC; systemd remains authoritative for installed services. The direct launcher
keeps one instance lock across replacement. It accepts a restart identity only while it still owns
the lock, and replaces only after the accepted child reports a dedicated clean restart exit.
Normal stop, failed cleanup, and lost/late acceptance cannot accidentally consume an old intent.

The source Host runs through Node's supported `--import tsx` hook so the tracked IPC child is the
actual Host, not an extra CLI wrapper. Packaged Hosts use the same protocol without a loader.
Native-source lifecycle regression checks repeat page restart with a live independent terminal;
the installed-package verifier restarts a real Host with an idle owned Pi worker. Both belong to the
existing Linux/macOS/Windows CI paths. Protocol tests also cover missing owners, lock loss, uncertain
delivery, failed cleanup, and stop after early instance-state removal.

Pairing names the launcher without assuming `./inspire`; local recovery offers both installed-package
and source-checkout commands that work on all supported platforms. Browser OS is not a reliable proxy
for the Host OS, so guidance does not choose commands from the browser's platform.

Capabilities must stay scope-specific: ordinary restart does not imply terminal-service replacement.
Portable terminal-daemon maintenance is separate: `inspire terminal` authenticates and replaces only
that daemon, without restarting the Host or widening Restart all. Herdr enhancement, managed reverse
SSH, and scheduled systemd maintenance intentionally remain Linux-only.

## Native PTY cleanup ownership

`server/terminal-pty.ts` observes native exit before callers can request cleanup and captures the
startup process birth. `server/terminal-process-tree.ts` requires that authority before walking or
signalling the root tree/group. A root exit or identity change cannot authorize another traversal
of its old PID/PGID. Retained descendants need matching live identities; Linux parent/birth come
from the same `/proc` stat, and macOS descendants are checked in batches at the existing `ps` birth
precision. Incomplete discovery and unconfirmed retirement retain cleanup state instead of declaring
success after issuing SIGKILL. These are live OS observations, not atomic kernel process handles.

Windows delayed/pending PID identity permits only native ConPTY closure. A completed startup lookup
cannot regain numeric authority after native close begins; live verification and taskkill share the
existing control window. Exit/timeout aborts the PTY’s own metadata subprocess, without cancelling
shared Host self-identity work. Native session closure is meaningful ownership: Windows terminates
its [attached console clients](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session#ending-the-pseudoconsole-session),
not an arbitrary process that later reuses a numeric PID.

Root output drain and descendant retirement share the hard-stop allowance. Failed cleanup keeps even
an exited tab available for explicit retry, and failed daemon shutdown does not release its lifetime
lease or admit replacement. Tests retain real HUP-resistant and detached-child retirement alongside
replacement/late-exit contracts. Updating this code requires replacing the terminal runtime; ordinary
Host restart intentionally preserves it. See [[terminal]] and
[terminal maintenance](../../docs/host.md#terminal-service-maintenance).

## Private terminal transport

Local pipes are not peer authentication. A Windows pipe name can be occupied before the intended
daemon starts; Unix paths also need current-user directory ownership. Terminal IPC uses Node's
certificate-free TLS 1.2 PSK/AES-GCM support, not a custom challenge protocol. No RPC or attachment
data leaves the client before the peer proves the shared secret. Plaintext replies cannot satisfy
that handshake. The `.tls-v3` authority is newly generated instead of reusing any plaintext-era key.
The protocol contract is in [[terminal]]; fake-listener, wrong-key, old-protocol and shutdown cases
are in `tests/server/terminal-daemon-auth.test.ts`.

Windows pipe identity includes the account and state location. Unix defaults remain stable when
short enough, and use a short current-user-private location when the selected runtime/tmp root
exceeds the native address bound. Byte length matters for Unicode roots. Test the actual default
address, not just a short override. Existing non-private token/socket parents are rejected without
chmodding them; an override must not change permissions on `/tmp` or another shared/system directory.

A delayed terminal cleanup must not remove its successor's address. Keep lifecycle controls reachable
while PTYs drain, fence data requests, and close the listener only after cleanup succeeds. Node owns
the pathname unlink; do not add another after drain. Failed cleanup keeps its failed sessions and
allows an explicit retry instead of silently discarding them.

The lifecycle-v1 envelope is versioned separately from terminal-data IPC so maintenance can survive
a data-protocol upgrade. [[terminal]] owns authenticated identity, lifetime leases, confirmed exit
and service authority.

Detached fallback strips the parent's service notification/socket-activation variables. Otherwise a
daemon launched from a Host service can inherit the Host's notify socket or mistake that service for
its own supervisor. systemd launch is bounded and detached spawn errors are observed.
Installed-package checks exercise real default-daemon I/O, preserve its PTY across ordinary page
restart, and independently exercise portable status/restart/stop.

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

WebKit native attachment downloads can omit both Origin and Fetch Metadata. An anchor with
`rel=noreferrer` then removes the final usable same-origin signal. Resource downloads instead set
`referrerPolicy=origin`; only when the other proofs are absent may an exact-origin Referer authorize
the already authenticated, one-use resource/session ticket. Explicit conflicting headers still reject.
The server keeps its global no-referrer policy, and the download never sends page paths, queries or
the API bearer. Chromium, Firefox and WebKit regressions verify complete native large-file bytes and
ticket replay rejection. See [[resource-preview]] and [[host-lifecycle]].

Windows drive discovery enumerates assigned drive names without testing every root. A disconnected
mapping can hang `stat`; root discovery must neither touch it nor gate the current directory listing.
Actual availability is checked on navigation. Native-hidden entries are filtered before resolving
symlinks/junctions; otherwise an invisible redirected/offline target can still block Home browsing.
Explicit show-hidden retains link traversal. Browser paths are opaque Host values, not re-parsed
using the browser machine's separators.

Browsers send ordinary multipart filenames as UTF-8; Multer's default legacy charset can corrupt
non-ASCII names before storage. Uploads explicitly select UTF-8, then keep readable names independent
of bounded physical cache components. Component budgets cover UTF-8 bytes and HFS+ decomposition,
retain code-point boundaries and ordinary extensions, and avoid Windows-trimmed trailing characters.
Versioned ownership validates new names; existing unversioned ownership retains its original exact
paths rather than renaming historical references. See [[composer]].

Portable daily workflows stay in their semantic browser suites and opt into all engines with
`@cross-browser`. OS-sensitive font, clipboard, scrolling and window-control fixtures use
`@platform-ui` for the focused native Chromium matrix. Mock-routing suites block Service Workers so interception is deterministic;
real PTY, upload and native download suites still exercise their actual transports. Native clipboard
write observation waits for the original browser call to succeed rather than replacing it with a
fake implementation. Browser engine coverage is separate from native Windows/macOS filesystem and
shell verification.

## PTY backends and command markers

The selected backend is `@lydell/node-pty@1.2.0-beta.15`, with prebuilt binaries. It avoids the
observed cleanup hang and Linux build requirements of upstream `node-pty@1.1.0`. Windows explicitly
uses bundled ConPTY (`useConptyDll: true`); the sampled win32-x64 payload is Microsoft ConPTY
`1.25.260303002-preview`. These are prerelease dependencies. The OS backend can deliver OSC markers
before enclosed text, breaking last-output copy; backend selection therefore affects correctness.

PowerShell integration uses a process-only execution policy so a fresh Windows client's Restricted
policy does not block the app-owned script. It never changes user/machine policy, and enforced Group
Policy still wins. Zsh wrappers follow ZDOTDIR changes at every startup stage rather than capturing
one directory before .zshenv runs; they restore its native declaration for user files and the final
shell and leave RCS/readonly controls authoritative.

PowerShell emits its execution marker after `PSConsoleHostReadLine` returns the accepted command.
Wrapping the reader preserves PSReadLine bindings and multiline input. Rebinding Enter would mark
unfinished input as execution.

Bash ignores rcfile/init-file injection for a genuine login shell, even with noprofile. Replaying
profiles from a non-login shell cannot restore login_shell or native .bash_logout. Login integration
therefore uses an inherited first-prompt bootstrap without changing HOME/ENV or feeding stdin.
User startup can replace/lock PROMPT_COMMAND; marker loss then means ordinary PTY operation, not
permission to override user initialization. Non-login shells keep native bashrc semantics.

Command labels use the accepted history entry: fc-based relative lookup can select the previous
line during command substitution. Bash 4.4+ provides `PS0`. Older Bash uses a top-level DEBUG event composed with existing traps;
standalone subshell-only lists may provide no such event and therefore no copyable output range.
Bash 5.1+ supports array-valued `PROMPT_COMMAND`; earlier versions need newline-separated shell
commands while retaining the original exit status.

Close and restart wait for confirmed PTY exit. Windows kill calls take no POSIX signal argument.
Interactive Bash exposes process-exit behavior that a non-interactive command may miss, so native
terminal checks need a real interactive shell as well as mocked transport coverage.

Native test fixtures use `tests/server/fixtures/isolated-environment.ts` to replace Windows
variables case-insensitively while preserving inherited key spelling. Adding `PATH` beside an erased
`Path` can hide the intended override because Node deduplicates keys before dropping undefined values.

Wait for lifecycle signals rather than treating a one-second poll as the protocol deadline.
Loading-state fixtures hold the explicit action, not an assumed ordinal initial request. Native
clipboard comparisons retain all text/lines while accounting for Windows CRLF.

Mixed native font stacks expose box-centering errors that may be invisible with another platform's
fonts. Prompt navigation aligns text by its shared baseline and centers the neighboring SVG separately;
it does not use OS-specific pixel offsets or change the virtual row height. Baseline estimates that
combine Range position and Canvas ascent allow one CSS px on every engine, because independently
rounded metrics do not establish half-pixel precision. Actual DOM columns, boundaries and padding
retain 0.5 px checks; this measurement distinction does not authorize product CSS compensation.

Relevant suites: `tests/server/terminal-*.test.ts`, `tests/portable/`,
`tests/deploy/systemd-control.test.mjs` and `tests/launcher.test.ts`.
