---
purpose: Project-scoped terminals survive browser and Host interruptions, with explicit input ownership and ordered xterm tabs.
covers:
  - package.json
  - package-lock.json
  - inspire
  - inspire.mjs
  - deploy/systemd/**
  - scripts/{build-release,start-browser-test-host,verify-release-package}.mjs
  - server/{app,index,terminal-*}.ts
  - server/{platform-environment,user-environment}.{mjs,d.mts}
  - shared/terminal-*.ts
  - src/{api,App,app-state,store,terminal-*,use-copied}.ts*
  - src/controllers/terminal-operation-controller.ts
  - src/components/{CommandPalette,ContextPane,RichText,TerminalPane,TerminalSettingsDialog,TerminalTextDialog,TerminalView}.tsx
  - src/styles.css
  - src/styles/{terminal,responsive,workbench}.css
  - tests/{server,shared,web}/**/*terminal*
  - tests/browser/{project-terminals,operation-lifecycles,terminal-settings,terminal-theme}.spec.ts
  - tests/browser/fixtures/terminal-theme.ts
  - tests/deploy/systemd-control.test.mjs
  - tests/launcher.test.ts
  - vite.config.ts
---

# Project terminal

## Goal

Provide interactive project shells inside the workbench, including through `ssh-reverse`. Terminals
have the operating-system user's full authority; Pi and browser presentation do not own their processes.

## Process ownership

A private daemon owns PTYs, bounded output rings, headless terminal state, tab metadata, and optional
history. Its installation-scoped IPC endpoint authenticates current-user clients. Each absolute project
cwd owns an ordered set of up to 32 tabs, within a global limit of 128.

IPC authenticates both peers before sending controls, paths or input and encrypts terminal traffic.
No handshake sends a reusable token or downgrades to the earlier plaintext protocol. The TLS authority
is a newly generated private secret, separate from any potentially disclosed plaintext-era token.
Windows machine-wide pipe names include the OS account and state-directory identity as well as the
installation. Unix socket addresses stay within the native byte limit, including long and Unicode
temporary roots; shortening does not relax current-user ownership or private-directory checks.
A still-listening legacy address blocks automatic replacement rather than stranding its PTYs.
Only the owner that bound a socket removes it; late cleanup must not unlink a successor.
An existing non-private POSIX parent is rejected rather than chmodded, so a custom socket, token or
state address cannot change permissions on a shared or system directory.

`inspire terminal status|stop|restart` supplies portable, instance-scoped maintenance without
restarting the Host/Pi or expanding Restart all. Stop/restart run from an external OS terminal;
a managed-terminal environment is refused before stopping work so the command cannot kill its own
coordinator midway through replacement. Status remains available there. An independent lifecycle-v1 envelope over the same
authenticated TLS transport survives terminal-data protocol changes. The caller verifies root, Host,
port, configured IPC/state/token paths, process birth and daemon incarnation before requesting stop.
Shutdown targets that incarnation; an old target cannot stop a replacement. Status never creates or
rotates authority and reports missing listeners without claiming OS-process exit.

Running project terminals require explicit `--force`; it confirms ending work, not a bypass for
authentication or unknown-PID killing. Admission fences pending creates before shutdown. Failed PTY
cleanup retains failed sessions, rejects shutdown completion and leaves lifecycle controls reachable
for inspection/retry while data requests are fenced. A lifetime lease covers startup, state writing
and complete PTY drain; CLI controls serialize handoff and confirm actual process exit before replacement.
Saved tabs restore as exited without executing commands. The dedicated installed terminal unit retains
systemd ownership; arbitrary enclosing services are never treated as terminal restart authority.

Detached daemon fallback removes inherited service notification/socket-activation identity, and
systemd handoff has a bounded wait. A detached spawn error rejects launch instead of escaping as an
unhandled process event.

Opening or hiding the pane attaches or detaches views. Explicit close terminates the process tree;
exited tabs retain output until closed or restarted. Reopening a recently closed tab creates a fresh
process from its profile. Host restart reconnects to the daemon. Machine restart restores known tabs
as exited, without rerunning commands. Live and restored tabs share headless-state setup; failed PTY
creation disposes emulator resources before publishing a tab.

The daemon receives the user's exported environment through direct and installed-service launch paths
under [[host-lifecycle]]. User-supplied `NODE_ENV` remains authoritative. Host restart leaves existing
terminal environments unchanged.

Shell profiles are discovered from that environment. Windows variable names remain case-insensitive
in copied environments, and quoted PATH entries can contain spaces and semicolons. Discovery accepts
executable files, not directories, without adding implicit cwd lookup. POSIX shells, PowerShell,
Command Prompt, and WSL use `node-pty` with true-color xterm metadata. Supported wrappers preserve normal shell initialization
and emit cwd/command markers. Unsupported or failed integration still provides an ordinary PTY.

PowerShell loads the app-owned integration with a process-only execution policy, including on a
Windows client inheriting Restricted. It never writes CurrentUser/LocalMachine policy; enforced
Group Policy retains precedence. A failed cmdlet cannot inherit a stale zero native exit code and
report success. Zsh follows user changes to ZDOTDIR at each startup stage, restores its native
unset/exported state before user files and after startup, and respects RCS/readonly controls.
User login/logout files run through their normal locations, without a second replay.

Bash login profiles retain a real login shell and native profile/logout selection. Integration must
not simulate login by replaying profile files from a non-login rcfile, change HOME/ENV, inject a
command into stdin/history, or re-exec away non-exported shell state. A first-prompt bootstrap
installs markers after native login startup when the user's PROMPT_COMMAND permits it. A user
override/readonly hook may prevent integration; preserve that configuration and provide an ordinary
PTY rather than reporting invented command boundaries. Non-login Bash uses its normal bashrc path,
not login profiles. Both modern PS0 and legacy DEBUG hooks read the accepted history entry for the
command label; fc-based relative lookup can select a previous line while expanding command substitutions.

The native dependency is pinned to `@lydell/node-pty@1.2.0-beta.15`, with per-platform prebuilt binaries.
Windows explicitly uses its bundled ConPTY (`useConptyDll: true`) so shell markers and rendered output
remain ordered; there is no silent OS-backend fallback. The sampled win32-x64 payload is Microsoft
ConPTY `1.25.260303002-preview`. This tested prerelease/experimental backend choice avoids the observed
cleanup hang and Linux build requirements of upstream stable `node-pty@1.1.0`.

PowerShell wraps the existing `PSConsoleHostReadLine` and emits the execution marker only after the
reader returns the accepted command. It does not rebind Enter or emit execution markers for unfinished
multiline input. Existing PSReadLine handlers, profiles, launch flags and the original prompt remain
in charge. Backend ordering and this post-input boundary are both required for exact last-output copy.

Shell verification follows current installed dependencies, not a historical-version matrix.
Windows prefers the available PowerShell 7 profile; explicit profile selections remain available.
Bash uses `PS0` for accepted-command markers and preserves each prompt callback's original status.
The existing DEBUG-based path is best-effort for shells without that interface: it must not invent
command boundaries or change user tracing/inheritance. Dedicated old-Bash builds are not part of
the support baseline.

Close and restart require confirmed PTY exit. A bounded output-drain allowance follows hard
termination, and the Host RPC deadline covers the daemon's stop budget. Unconfirmed exit retains the
tab and reports failure. Native adapters capture the root birth identity at startup and recheck it
before numeric tree/group operations, including the output-drain period before `onExit`. Once the
root exits or its identity changes, its old PID/PGID cannot authorize another tree walk or group
signal. Only previously captured descendants with matching live birth identities remain cleanup
authority; a different observed birth never inherits prior cleanup authority. Unverifiable or unconfirmed descendant cleanup
keeps the exited tab and its cleanup handle for an explicit retry, including service shutdown.
Root drain and descendant confirmation share the existing hard-stop allowance. These are live OS
identity observations, not atomic kernel handles or a sandbox against deliberate process races.
Windows native ConPTY instance closure is the fallback when PID identity cannot be proven, and
receives no POSIX signal argument.

## Identified controls and recovery

Browser mutations carry one immutable operation identity through Host and daemon. Same-content retries
share the running operation or retained result; reuse with different parameters is refused. Lost
responses, deadlines, and disconnects leave the outcome unresolved, rather than cancelling work.
Read-only catalog/settings reads and attachment/input continuity remain independent.

| Receipt bound | Value |
| --- | --- |
| Daemon entries / serialized storage | 2,048 / 16 MiB |
| Individual result | 256 KiB |
| Result / tombstone retention | Ten minutes / one hour |
| Browser unresolved identities | 128 in tab-session storage |

Running operations are not evicted. Before forgetting an identity, reclamation fences its admission
epoch; daemon replacement also changes the epoch. Unknown old identities are refused. The browser
retains unresolved controls across pane, project, and reload generations, offers same-operation checks,
and releases them after a confirmed result or definite refusal. Unavailable or malformed storage blocks
untracked writes. Every control mutation requires an operation identity and receipt support; missing
identity is refused before dispatch. Valid identified requests rejected during route validation carry
the matching operation ID and definite rejected outcome, including nested terminal routes.

The in-process development owner follows the same mutation contract. An incompatible listening daemon
requires an explicit terminal-service upgrade; ordinary Host launch leaves its PTYs running.
Recovery guidance names the portable `inspire terminal` controls and explains that Host-only restart
cannot replace the daemon. Daemons predating lifecycle controls need a one-time upgrade through their
existing service manager or an inspected manual shutdown; commands never infer authority from an
unverified listener's claimed PID. Settings → System → Restart all remains limited to installed Linux
services. Receipt discovery preserves the incompatibility diagnosis.

Catalog loads, polling, and mutations belong to one pane project/reload generation. Switching projects,
reloading, or unmounting retires old response/error/loading/selection/rollback writebacks, while completed
server work remains effective. Full catalogs validate project and daemon epoch/revision; partial receipts
merge by ID within that epoch and do not suppress equal-revision full reconciliation. A new epoch needs
a complete catalog, and retired epochs cannot replace it. Optimistic-order rollback applies only to its
still-current state. Recovery rows retain uncertainty during checks; tab relationships target mounted
lazy panels.

## Stream, input, and authentication

Output carries an epoch, byte offset, and resize revision. Matching retained clients receive missing
bytes; stale epochs, evicted offsets, or incompatible dimensions receive a bounded headless-terminal
snapshot followed by the exact live tail. Ambiguous continuity requests a fresh snapshot. Interrupted
replay discards its incomplete screen.

| Transport observation | Deadline / cadence |
| --- | --- |
| Ticket, WebSocket opening, attachment | Ten seconds each |
| Replay before connected state | Thirty seconds |
| Application ping / receive silence | Ten / thirty seconds |

Retirement invalidates callbacks before reconnect, cancels pending ticket work, and retains valid
output/input continuity. Visibility and BFCache returns also retire stale transports.

Monotonically acknowledged input frames let reconnect resend only unacknowledged bytes. One attachment
owns input and PTY dimensions; other paired browsers remain live read-only viewers. Explicit takeover
revokes the previous writer. A disconnected writer can reclaim its lease with an opaque token during
the bounded grace period.

HTTP controls use explicit bearer authentication; WebSocket upgrades use the origin/audience-bound
socket tickets defined by [[host-lifecycle]]. Terminal attachment additionally consumes its
short-lived, terminal-bound ticket. Dimensions, titles, paths, messages, replay, IPC connections, pending input, and
outbound buffers are bounded. A slow viewer detaches independently of its PTY and other viewers.
Diagnostics omit terminal input, output, and internal path-bearing failures.

## Tabs, menus, and settings

The lazy Terminal mode provides profile choice, creation, rename, drag/keyboard ordering, restart,
close/force-close confirmation, recent-close recreation, status/unread/bell indicators, and an
all-project navigator. One header owns tabs, new/profile, connection/control state, search, focus, and
More. At pane widths up to 480px, Focus moves into More to leave room for the active tab and its close
control. Focus remains available with an empty catalog. Focus mode and a same-origin focused window
attach the existing terminal. With multiple available profiles, compact/touch creation presents
one Plus control that opens profile choice; the empty-state New button does the same without
creating prematurely. A single available profile creates directly. Wider desktop layouts keep default
New plus a separate chooser; command/keyboard New continues to create the default profile. The
input-focus icon uses neutral action color; process dots and connecting/reconnecting indicators
retain their state colors.

Selected tabs are revealed on selection or strip resize without stealing focus. Catalog reconciliation
restores saved selection before persisting a new value. Automatic focus belongs to a fresh activation
and yields if another control takes focus; font loading, replay, reconnect, and writer-state changes do
not reclaim it. Explicit Take control retains its user-gesture focus behavior.

Profile and More menus share one pane owner and a native named disclosure group for synchronous
mutual exclusion; inner groups remain independent. More contains clipboard/output actions, inline display
and management groups, the navigator, and settings. Escape closes the innermost group first and restores
its summary, without also closing a narrow drawer. A newer modal has priority. Menus fit and scroll
within the pane; header controls align across desktop/touch layouts, and hidden views publish no controls.
Profile names wrap within their text column when needed; the Default marker remains visible on the
first-line baseline. Short entries retain centered content, standard menu height, and target size.

The all-project navigator preserves project-name casing and uses lighter group text with the existing
neutral separators and accent Current marker. Visible case-insensitive literal search hits in project
names, terminal names and current commands use the shared unfilled semibold emphasis. Filtering and
catalog order remain unchanged. Rows stay single-line; command hints can use up to 42% of the available
row width, shrink for short values, and ellipsize within their track instead of a fixed 72px limit.
Terminal names retain the larger share of the row; status dots and switching behavior are unchanged.
Project headings append a secondary `@parent` cue when distinct catalog projects share a basename,
or when the query matches the immediate parent name but not the project basename. Collision counts
use unique project CWDs from the complete catalog, so multiple terminals in one project do not add
context and filtering does not remove an existing disambiguation cue. Only matched parent text is
emphasized, not `@`; clearing search removes query-only context. Ordinary unique headings remain
unchanged. The identity stays single-line and ellipsizes within the space left by Current.

Terminal Settings is a body-level modal, above the pane's stacking context. Its header/footer remain
visible around the scrolling body. Appearance, Interaction and Saved output are separate category views,
with the main Settings desktop sidebar, narrow horizontal strip and safe-area-aware narrow frame.
Only the active category exposes its controls. Switching or reselecting a category starts its content at the top; scrolling does not
change the selection. Browser preferences and Host loading, saving, clearing and error state survive
category switches. Settings and Select text restore focus to the visible More summary;
modal Escape leaves terminal focus mode and the underlying drawer unchanged. **Restore browser defaults**
resets browser presentation/interaction preferences, not Host history. This action and the browser
scope caption appear only in Appearance and Interaction; Saved output identifies its Host scope instead. Appearance, Interaction and
Saved output use the main Settings controls and dialog header, with 40px touch controls. Font size
uses an inline decrement/value/increment stepper at every width. Wide choices can move below their
labels on narrow cards. Browser preferences remain distinct from Host output and retention settings.

## Rendering and input

The xterm client supports ANSI/true color, alternate screens and mouse-capable TUIs, Unicode/IME,
selection, safe HTTP links, authenticated project-file links, search options, paste protection, reset,
clear, WebGL with renderer fallback, theme/font refitting, screen-reader mode, and configurable
cursor/font/scrollback/shortcuts. Translucent selection colors are resolved to RGBA before
crossing the xterm color-parser boundary. Theme changes repaint existing search decorations without
advancing the selected match, changing search options or moving the viewport. Passive theme/output
repainting preserves manual linear or rectangular selections, including an explicitly cleared
selection, independently of the active search match. Unrelated root layout changes do not rescan
unchanged search colors. Only explicit search navigation may select or scroll to a result.
File-link hit regions map UTF-16 offsets through xterm cells, preserving wide, combining, and
supplementary characters. Quoted filenames and absolute paths preserve spaces and line/column
suffixes rather than opening a truncated relative tail. Relative filenames containing spaces require
quotes. File/VS Code URIs and home syntax are interpreted by the Host; a browser never substitutes
its own filesystem or platform. Windows native home syntax includes both `~/` and `~\\`.
OSC 7 working-directory updates retain Windows drive/UNC identity and accept the local-hostname
form emitted by POSIX shells; these advisory markers grant no resource authority.

Search opens without changing PTY dimensions. On narrow or touch layouts, Close stays beside the
query while options and navigation flow below. The established keyboard order remains unchanged.
Case/whole-word/regex option changes refresh match counts and decorations; partial words must not hide
valid whole-word hits on the same line in either direction. Literal punctuation stays literal even with whole-word matching enabled.
Workbench shortcut mode retains native clipboard and terminal search. On macOS, Control+C sends
ETX with or without selected output; Command+C/V remain native copy/paste, and Control+V remains
shell input. On Windows/Linux, selected Control+C stays native copy, unselected Control+C sends
ETX, and Control+V stays native paste. Shell shortcut mode retains its existing Control-key ownership;
macOS Command clipboard chords remain native. Native AltGraph, third-level characters, dead keys and composition take priority
over workbench chords. Alt+digit selects a tab only when the layout produces that digit without other
modifiers; pane shortcuts do not capture search, rename, menu or ordinary text-editor input. A chord
consumed by the pane must not also send terminal bytes. macOS Option produces native characters and
accents by default. The Mac-only **Option as Meta** browser setting explicitly enables Escape-prefixed
shell keys; changing it updates the live terminal without replacing its input surface.

The existing Focus/Exit focus buttons and the command palette's **Toggle terminal focus** action
enter or leave focused view. Where Workbench global shortcuts are available, open the palette with
Control+K (Command+K on macOS), then choose that action. Narrow modal drawers retain their existing
Focus/Exit controls in the header or More menu. Shell mode retains its existing palette-key ownership. No
Control+Shift+Escape handler or hint claims the Windows Task Manager shortcut.
Workbench New terminal uses the physical modified Backquote key, including layouts where Shift
produces a tilde; shell shortcut mode yields it to the PTY. Shell history remains native; the view adds neither command reruns nor a separate history interface.

The non-wrapping touch bar keeps four 44px arrows fixed in a compact trailing group. Esc, Ctrl+C,
one-shot Ctrl/Alt, Tab, Home/End, and Page Up/Down scroll independently in equal-width slots sized
to fit complete buttons (two at 320px, three at 390px). Scrolling snaps to whole-key boundaries,
including the final position. Small directional cues use the existing bottom padding only on sides
with hidden keys; no fade covers button labels. The bar keeps its single-row height.
Input ownership, readiness and process state
gate every key. Touch keys preserve input focus. Navigation and direct Ctrl+C also work with the
software keyboard closed; the header keyboard button explicitly focuses input. Ctrl/Alt are one-shot modifiers for user
keystrokes, cleared by blur, loss of control, or paste. They do not modify pasted text or terminal replies.

Pending menu paste belongs to its originating activation and control epoch. Switching views, losing
control, or replacing the connection retires its completion/error/focus effects. A current paste returns
focus from the dismissed menu while respecting a newer focus choice.

## Selection and output

Selection actions appear with selected text, without a permanent toolbar row. Copy uses that selection;
quote sends inert fenced text to the current Composer. A Composer code block can be inserted into the
controlled terminal without submitting it.

More exposes Copy all and Select text independently of shell integration. Copy all reads retained
scrollback in the normal screen or screen content in an alternate-screen application. Select text
captures a stable read-only native selection view with Select all, Copy, and quote. Selection/copy does
not request the software keyboard; failed clipboard access remains visible beside manual selection.

Last-output copy uses the latest completed shell-marker range in the normal buffer, including cell
columns. It excludes the next prompt and joins soft wraps while preserving Unicode and actual spaces.
Marker eviction, buffer replacement/reset, or column reflow invalidates that range; height-only changes
preserve it. Other copy paths remain independent.

Shell completion coalesces Git refresh. Optional, user-gesture-authorized bell and long-task notifications
describe the outcome without exposing output content.

## Persistence and installation

Tab metadata and Host-wide history settings live in current-user-private state. Raw output persistence
defaults off. Opt-in history has size/age bounds, disabling it clears retained logs, and Settings offers
explicit clearing. Logs above 32 MiB trim to a 24 MiB tail with a reset prefix, leaving append headroom.
Writes run one batch at a time; output arriving during a slow write stays in the bounded pending buffer.
Browser-local preferences never become process authority.

Source, npm-release, direct-launch, and installed Linux service paths include the daemon and its runtime
dependencies. The terminal user service is separate from `inspire-host.service`: Host-only stop/restart
preserves PTYs; disabling the terminal service owns their shutdown. Explicit Restart all uses one ordered
systemd transaction for the verified installed services. Ordinary and automatic maintenance restart only
the Host.

## Boundaries

Terminal splitting, simultaneous writers, anonymous sharing, and public terminal-only links are outside
this design. Pi prompts/extensions gain no implicit ability to inspect or operate the human terminal.
Image protocols, OSC 52, recording, reboot command replay, containers, and tmux-specific attachment remain
future options.

[[platform-compatibility]] explains PTY backends and shell-marker constraints;
[[state-ownership]] explains operation receipts and catalog reconciliation.
