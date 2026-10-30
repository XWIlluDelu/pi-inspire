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
  - src/components/{CommandPalette,ContextPane,NoticeCard,Notices,RichText,TerminalPane,TerminalSettingsDialog,TerminalTextDialog,TerminalView}.tsx
  - src/styles.css
  - src/styles/{terminal,responsive,settings-overlays,workbench}.css
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
Wire/authentication compatibility gates data access; implementation version and optional lifecycle
support do not. A failed startup connection remains recoverable through subsequent requests: one
shared initialization at a time, no idle retry loop, no automatic daemon creation/replacement and
no replay of dispatched controls or terminal input. Closing fences late initialization and closes
its client without reviving the retired service.
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
unhandled process event. A confirmed listening-owner conflict has a distinct error and exit code 78;
installed and transient systemd units prevent restart for that exit without suppressing retries for
ordinary crashes. Startup checks a listening owner before creating authority or restoring state.
Service start/enable do not stop a transient owner; Host Wants/After dependencies preserve installed
startup ordering without treating a duplicate terminal start as authority to end existing work.

Opening or hiding the pane attaches or detaches views. Explicit close terminates the process tree;
exited tabs retain output until closed or restarted. Reopening a recently closed tab creates a fresh
process from its profile. Host restart reconnects to the daemon. Machine restart restores known tabs
as exited, without rerunning commands. Live and restored tabs share headless-state setup; failed PTY
creation disposes emulator resources before publishing a tab.

The daemon receives exported variables under [[host-lifecycle]]; Host restart leaves existing
terminal environments unchanged. Profile discovery accepts executable files without implicit cwd
lookup. Copied Windows environments preserve case-insensitive names and quoted PATH entries containing
spaces or semicolons.

POSIX shells, PowerShell, Command Prompt and WSL use a PTY with true-color xterm metadata. Shell
integration preserves native initialization and user bindings while reporting cwd/command boundaries.
Unsupported integration provides an ordinary PTY. Backend selection must preserve marker/output
ordering; Windows uses the selected bundled ConPTY without silently falling back to the OS backend.
[[platform-compatibility#PTY backends and command markers]] records the package, rationale and native evidence.

- PowerShell loads app-owned integration with a process-only execution policy. User/machine policy
  is unchanged and enforced Group Policy takes precedence. The execution marker follows the accepted
  command returned by `PSConsoleHostReadLine`, preserving PSReadLine bindings, multiline input,
  profiles, launch flags and the original prompt. A failed cmdlet cannot inherit a stale successful
  native exit code.
- Zsh follows ZDOTDIR at each startup stage, restoring its native unset/exported state for user files
  and the final shell. RCS/readonly controls and normal login/logout locations remain authoritative;
  user files run once.
- Bash retains a real login shell and native profile/logout selection. Integration may not replay
  profiles from a non-login shell, change HOME/ENV, inject stdin/history commands or discard
  non-exported state through re-exec. Its first-prompt bootstrap respects user PROMPT_COMMAND;
  overridden/readonly hooks may leave an ordinary PTY. Non-login shells retain native bashrc behavior.
  Accepted-command labels come from the accepted history entry, using PS0 where available and the
  best-effort DEBUG path otherwise. Preserve original prompt status, tracing and inheritance;
  unavailable markers must not invent command boundaries.

Verification targets installed, supported shells. Windows prefers available PowerShell 7 while
retaining explicit profile choices; dedicated historical-Bash builds are outside the support baseline.

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
Read-only catalog/settings reads and attachment/input continuity remain independent. A confirmed
completion or rejection remains authoritative even if the browser cannot remove its recovery record.
Report that local cleanup failure separately; retrying cleanup sends no terminal mutation.

| Receipt bound | Value |
| --- | --- |
| Daemon entries / serialized storage | 2,048 / 16 MiB |
| Individual result | 256 KiB |
| Result / tombstone retention | Ten minutes / one hour |
| Browser unresolved identities | 128 in tab-session storage |

Running operations are not evicted. Before forgetting an identity, reclamation fences its admission
epoch; daemon replacement also changes the epoch. Unknown old identities are refused. The browser
retains unresolved controls across pane, project, and reload generations, offers same-operation checks,
and releases them after a confirmed result or definite refusal. After inspecting current terminals,
users may explicitly stop tracking an unresolved result, including an expired receipt or retired epoch.
Confirmation explains that this neither cancels the old work nor establishes its outcome. It sends no
mutation, persists retirement before releasing the local identity, and is unavailable during a check.
A subsequent deliberate action gets a new identity; retries never silently become new work.
Unavailable or malformed storage blocks
untracked writes. Every control mutation requires an operation identity and receipt support; missing
identity is refused before dispatch. Valid identified requests rejected during route validation carry
the matching operation ID and definite rejected outcome, including nested terminal routes.

The in-process development owner follows the same mutation contract. Diagnostics distinguish absent
endpoints, unverified connections and data-protocol incompatibility. Terminal errors use the shared
notice card with complete Copy and separate Dismiss; text selection does not dismiss them.

An incompatible daemon requires an explicit upgrade after its work is finished. Without verified
maintenance controls, use its existing service owner or an inspected manual shutdown, never a PID
claimed by an unverified listener. [Maintenance guidance](../../docs/host.md#connection-recovery-and-upgrades)
covers this boundary and the installed-service scope of Restart all.

Catalog loads, polling, and mutations belong to one pane project/reload generation. Switching projects,
reloading, or unmounting retires old response/error/loading/selection/rollback writebacks, while completed
server work remains effective. Full catalogs validate project and daemon epoch/revision; partial receipts
merge by ID within that epoch and do not suppress equal-revision full reconciliation. A new epoch needs
a complete catalog, and retired epochs cannot replace it. Optimistic-order rollback applies only to its
still-current state. Recovery rows retain uncertainty during checks; tab relationships target mounted
lazy panels.

Palette UI intent binds the originating project before opening a lazy pane. Close, Restart and
other terminal-targeted actions resolve an active terminal in that scope immediately or end without
an HTTP request; they never wait for a later project or terminal. Only New, Focus and Settings may
wait for their matching project surface to mount. `terminal-actions.test.ts` and
`terminal-pane.test.tsx` cover the pre-request cross-project boundary.

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

Each project terminal occupies a tab beside open files in the shared contextual strip. Terminal
tabs use the file tab's padding, close slot, width cap and overflow rules; each 6px status dot
sits within the same 13px icon slot. Names retain natural width rather than an invented fixed size.
Selecting a file or tool hides the terminal view without replacing its process or changing input ownership.
The top Terminal shortcut creates and activates one default-profile terminal; existing terminals
are reached through their tabs. The pane reads the catalog when the shared strip first opens so
existing terminal tabs remain reachable after refresh, including from Files. Background catalog
polling remains limited to the active terminal surface.

Profile choice, connection/control state, search, focus and More form a compact floating group at
the same 24px desktop / 32px touch/narrow button tier as file actions, with 14px glyphs and shared
padding/gaps. The status/focus and search slots are reserved before the view mounts, so connection
updates do not resize the group. Normal writable state has no visible Controlling label; its
accessible state/tooltip and keyboard-focus action remain. Non-writable states retain connection
feedback, the ownership message and Take control where ready. These controls sit at
the output's top-right, without a second tab/header row. An explicit Hide/Show toggle and Escape
control its visibility; terminal output/input interactions and background output preserve that choice.
Search, selection actions and copy confirmation temporarily own the same corner, making the floating
group unavailable until those overlays close without changing its expanded/collapsed state. There
is no duplicate default-New button in this group; the profile chooser retains named alternatives.
At pane widths up to 480px, Focus remains in More. Focus mode and same-origin focused windows
attach the existing terminal and retain their own accessible tab strip.

Rename, drag/keyboard ordering, close/force-close confirmation, recent-close recreation,
status/unread/bell indicators and the all-project navigator retain their behavior. Closing a
running command requires confirmation; Reopen creates a fresh shell rather than resuming a
terminated process. Command/keyboard New creates the default profile. The input-focus icon uses
neutral action color; process dots and connecting/reconnecting indicators retain their state colors.

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
quote appends inert fenced text to the current Composer without submitting or replacing its draft.
Successful quoting closes a narrow Context drawer and focuses the editable Composer after modal
focus restoration. Desktop Context stays open. A Composer code block can be inserted into the
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
describe the outcome without exposing output content. They share browser permission discovery,
requests and permission messages with task alerts, while keeping terminal delivery and preferences
independent. A denied, dismissed or unavailable permission leaves long-task alerts off or falls back
to a tab-marking bell, with an explanation beside the initiating setting. A delayed permission result
updates only its setting, preserving newer browser preference edits.
System display uses the existing service worker when available, including on mobile. Delivery failures
retain the terminal's visual mark and never interrupt its output or connection.

## Persistence and installation

Tab metadata and Host-wide history settings live in current-user-private state. Raw output persistence
defaults off. Opt-in history has size/age bounds, disabling it clears retained logs, and Settings offers
explicit clearing. Logs above 32 MiB trim to a 24 MiB tail with a reset prefix, leaving append headroom.
Writes run one batch at a time; output arriving during a slow write stays in the bounded pending buffer.
Browser-local preferences never become process authority.

Source, npm-release, direct-launch, and installed Linux service paths include the daemon and its runtime
dependencies. The terminal user service is separate from `inspire-host.service`, so Host-only
lifecycle operations preserve PTYs. Disabling the terminal service ends them. [[host-lifecycle]] defines CLI stop and
Restart all, which address both installed services, and Host-only ordinary/automatic restart.

## Boundaries

Terminal splitting, simultaneous writers, anonymous sharing, and public terminal-only links are outside
this design. Pi prompts/extensions gain no implicit ability to inspect or operate the human terminal.
Image protocols, OSC 52, recording, reboot command replay, containers, and tmux-specific attachment remain
future options.

[[platform-compatibility]] explains PTY backends and shell-marker constraints;
[[state-ownership]] explains operation receipts and catalog reconciliation.
