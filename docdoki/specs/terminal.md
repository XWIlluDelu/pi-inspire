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
  - shared/terminal-*.ts
  - src/{api,App,app-state,store,terminal-*,use-copied}.ts*
  - src/controllers/terminal-operation-controller.ts
  - src/components/{CommandPalette,ContextPane,RichText,TerminalPane,TerminalSettingsDialog,TerminalTextDialog,TerminalView}.tsx
  - src/styles.css
  - src/styles/{terminal,responsive,workbench}.css
  - tests/{server,shared,web}/**/*terminal*
  - tests/browser/{workbench,operation-lifecycles,terminal-settings}.spec.ts
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

Opening or hiding the pane attaches or detaches views. Explicit close terminates the process tree;
exited tabs retain output until closed or restarted. Reopening a recently closed tab creates a fresh
process from its profile. Host restart reconnects to the daemon. Machine restart restores known tabs
as exited, without rerunning commands. Live and restored tabs share headless-state setup; failed PTY
creation disposes emulator resources before publishing a tab.

The daemon receives the user's exported environment through direct and installed-service launch paths
under [[host-lifecycle]]. User-supplied `NODE_ENV` remains authoritative. Host restart leaves existing
terminal environments unchanged.

Shell profiles are discovered from that environment. POSIX shells, PowerShell, Command Prompt, and WSL
use `node-pty` with true-color xterm metadata. Supported wrappers preserve normal shell initialization
and emit cwd/command markers. Unsupported or failed integration still provides an ordinary PTY.

Close and restart require confirmed PTY exit. A bounded output-drain allowance follows hard
termination, and the Host RPC deadline covers the daemon's stop budget. Unconfirmed exit retains the
tab and reports failure. Windows native PTY kill calls receive no POSIX signal argument.

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
requires an explicit terminal-service upgrade; ordinary Host launch leaves its PTYs running and reports
Settings → System → Restart all or `inspire restart --all`. Receipt discovery preserves that diagnosis.

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

HTTP controls require the paired cookie or explicit API bearer. `/terminal` WebSocket attachment
requires an exact same-origin paired cookie and short-lived, single-use ticket; IDs and query tokens
are not credentials. Dimensions, titles, paths, messages, replay, IPC connections, pending input, and
outbound buffers are bounded. A slow viewer detaches independently of its PTY and other viewers.
Diagnostics omit terminal input, output, and internal path-bearing failures.

## Tabs, menus, and settings

The lazy Terminal mode provides profile choice, creation, rename, drag/keyboard ordering, restart,
close/force-close confirmation, recent-close recreation, status/unread/bell indicators, and an
all-project navigator. One header owns tabs, new/profile, connection/control state, search, focus, and
More. At pane widths up to 360px, Focus moves into More to leave room for the active tab and its close
control. Focus remains available with an empty catalog. Focus mode and a same-origin focused window
attach the existing terminal.

Selected tabs are revealed on selection or strip resize without stealing focus. Catalog reconciliation
restores saved selection before persisting a new value. Automatic focus belongs to a fresh activation
and yields if another control takes focus; font loading, replay, reconnect, and writer-state changes do
not reclaim it. Explicit Take control retains its user-gesture focus behavior.

Profile and More menus share one pane owner. More contains clipboard/output actions, inline display
and management groups, the navigator, and settings. Escape closes the innermost group first and restores
its summary, without also closing a narrow drawer. A newer modal has priority. Menus fit and scroll
within the pane; header controls align across desktop/touch layouts, and hidden views publish no controls.

Terminal Settings is a body-level modal, above the pane's stacking context. Its header/footer remain
visible around the scrolling body. Appearance, Interaction and Saved output are separate category views,
with the main Settings desktop sidebar, narrow horizontal strip and safe-area-aware narrow frame.
Only the active category exposes its controls. Switching or reselecting a category starts its content at the top; scrolling does not
change the selection. Browser preferences and Host loading, saving, clearing and error state survive
category switches. Settings and Select text restore focus to the visible More summary;
modal Escape leaves terminal focus mode and the underlying drawer unchanged. **Restore defaults**
resets browser presentation/interaction preferences, not Host history. Appearance, Interaction and
Saved output use the main Settings controls and dialog header, with 40px touch controls. Font size
uses an inline decrement/value/increment stepper at every width. Wide choices can move below their
labels on narrow cards. Browser preferences remain distinct from Host output and retention settings.

## Rendering and input

The xterm client supports ANSI/true color, alternate screens and mouse-capable TUIs, Unicode/IME,
selection, safe HTTP links, authenticated project-file links, search options, paste protection, reset,
clear, WebGL with renderer fallback, theme/font refitting, screen-reader mode, and configurable
cursor/font/scrollback/shortcuts. File-link hit regions map UTF-16 offsets through xterm cells, preserving
wide, combining, and supplementary characters.

Search opens without changing PTY dimensions. Workbench shortcut mode retains selected-copy, native
paste, and terminal search; shell mode yields those keys to the PTY. `Ctrl+Shift+Escape` exits terminal
focus when the event belongs to that pane. Shell history remains native; the view adds neither command
reruns nor a separate history interface.

Touch keys preserve input focus. Navigation and direct Ctrl+C also work with the software keyboard
closed; the header keyboard button explicitly focuses input. Ctrl/Alt are one-shot modifiers for user
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
Browser-local preferences never become process authority.

Source, npm-release, direct-launch, and installed Linux service paths include the daemon and its runtime
dependencies. The terminal user service is separate from `inspire-host.service`: Host-only stop/restart
preserves PTYs; disabling the terminal service owns their shutdown. Explicit Restart all uses one ordered
systemd transaction for the verified installed services. Ordinary and automatic maintenance restart only
the Host.

## Boundaries and evidence

Terminal splitting, simultaneous writers, anonymous sharing, and public terminal-only links are outside
this design. Pi prompts/extensions gain no implicit ability to inspect or operate the human terminal.
Image protocols, OSC 52, recording, reboot command replay, containers, and tmux-specific attachment remain
future options.

[[terminal-ci-portability]] records cross-platform runtime and exit checks.
[[operation-lifecycle-ownership]] covers receipts, upgrade behavior, and uncertainty.
[[terminal-controls-redesign]] and [[follow-interface-review-2026-09-29]] record controls, clipboard,
settings, and browser verification. [[follow-frontend-refinement-2026-10-07]] records the category-view
batch and its focused navigation/state checks.
