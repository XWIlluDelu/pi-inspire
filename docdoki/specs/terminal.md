---
purpose: Project-scoped PTYs live in an independent private daemon and appear as ordered xterm tabs that paired local or remote browsers can detach from and resume without making the browser or Pi authoritative.
covers:
  - package.json
  - package-lock.json
  - inspire
  - inspire.mjs
  - deploy/systemd/**
  - scripts/build-release.mjs
  - scripts/start-browser-test-host.mjs
  - scripts/verify-release-package.mjs
  - server/app.ts
  - server/index.ts
  - server/terminal-*.ts
  - shared/terminal-*.ts
  - src/api.ts
  - src/App.tsx
  - src/app-state.ts
  - src/store.ts
  - src/terminal-*.ts
  - src/components/CommandPalette.tsx
  - src/components/ContextPane.tsx
  - src/components/RichText.tsx
  - src/components/TerminalPane.tsx
  - src/components/TerminalSettingsDialog.tsx
  - src/components/TerminalView.tsx
  - src/styles.css
  - src/styles/terminal.css
  - src/styles/responsive.css
  - src/styles/workbench.css
  - tests/{server,shared,web}/**/*terminal*
  - tests/browser/workbench.spec.ts
  - tests/deploy/systemd-control.test.mjs
  - tests/launcher.test.ts
  - vite.config.ts
---

# Project terminal

## Goal

Provide complete interactive shells inside the contextual workbench, including through `ssh-reverse`, while preserving terminal processes across browser, tunnel, and ordinary Host interruptions and making their full-user authority explicit.

## Checks

- Each absolute project working directory owns one ordered set of up to 32 terminal tabs, within a global limit of 128. Opening or hiding the pane only attaches or detaches views; explicit close terminates the process tree, exited tabs retain their output until closed or restarted, and reopening a recently closed tab creates a fresh process from the same profile rather than pretending to restore the old process.
- A private terminal daemon, not the Inspire Host or Pi runtime, owns PTYs, bounded output rings, headless terminal state, tab metadata, and optional output history. It uses an installation-scoped authenticated local IPC endpoint with current-user permissions. Host restart reconnects to that daemon; machine restart restores known tabs as exited, never reruns their commands, and never claims their processes survived.
- Available shell profiles are discovered on the Host from the user's environment. POSIX shells and Windows PowerShell, Command Prompt, and WSL run through `node-pty` with true-color xterm environment metadata; supported shell wrappers preserve normal initialization and emit advisory working-directory and command-boundary markers, while unsupported or failed integration falls back to an ordinary PTY.
- Raw terminal output carries an epoch, monotonic byte offset, and resize revision. A retained matching client resumes with only its missing bytes; any stale epoch, evicted offset, or incompatible size receives a bounded serialization of the daemon's headless terminal followed by the exact live tail. Client continuity checks fail closed into a fresh snapshot rather than rendering an ambiguous stream.
- Ticket acquisition, WebSocket opening, and attachment each have a ten-second deadline; replay has a thirty-second deadline and must complete before the transport is connected. Ready clients send application pings every ten seconds and retire a transport after thirty seconds without incoming application frames, including stale visibility/BFCache returns. Retirement invalidates old callbacks before reconnecting, cancels pending ticket work, retains valid output/input continuity, and discards incomplete snapshots rather than resuming from a partial screen.
- File-link hit regions map UTF-16 regex offsets through xterm buffer cells, preserving wide, combining, and supplementary characters rather than treating string indices as columns.
- Input uses monotonically acknowledged frames so a reconnect can resend only unacknowledged bytes without duplicating accepted input. One attachment owns input and PTY dimensions at a time; other paired browsers remain live read-only viewers, explicit takeover revokes the previous writer, and a disconnected writer may reclaim its lease with an opaque token only during the bounded grace period.
- Terminal HTTP controls require the existing paired cookie or explicit API bearer. The dedicated `/terminal` WebSocket accepts only an exact same-origin paired cookie and a short-lived single-use attach ticket; terminal identifiers and forwarded query tokens are not credentials. Terminal count, dimensions, titles, paths, message sizes, replay storage, IPC connections, browser pending input, and outbound buffers are bounded; a slow viewer detaches without blocking its PTY or other viewers. Diagnostics omit terminal input, output, and internal path-bearing failures.
- The lazy contextual Terminal mode provides tab creation, profile choice, renaming, drag ordering, duplication, restart, close/force-close confirmation, recent-close recreation, filtering for larger tab sets, status/unread/bell indicators, and an all-project terminal navigator. It deliberately provides no terminal splitting. Focus mode and a same-origin focused window attach the same terminal rather than spawning another shell.
- Profile, action, all-project, and command-history menus share one pane-scoped owner: opening one closes the others. Escape from a menu closes it and restores its summary before a narrow Context drawer may close; a newer modal retains priority. Menu summaries and adjacent toolbar buttons share vertical alignment on desktop and touch layouts.
- The xterm client supports ANSI/true color, alternate screen and mouse-capable TUIs, Unicode and IME input, selection, safe HTTP links, authenticated project-file links, search options, command-boundary navigation, copy, paste protection, reset, clear, WebGL with renderer fallback, theme/font refitting, screen-reader mode, configurable cursor/font/scrollback/shortcuts, and a touch key row on narrow screens. Workbench shortcut mode preserves selected-copy, native paste, and terminal search while shell mode yields those control keys to the PTY; `Ctrl+Shift+Escape` exits terminal focus.
- Terminal selection can be copied or sent to the current Composer as inert fenced text. A Composer code block may be inserted into the controlled terminal but is never submitted automatically. Shell completion coalesces a Git refresh; optional user-gesture-authorized bell and long-task notifications describe terminal outcome without exposing output content.
- Tab metadata and Host-wide history settings persist in current-user-private state. Raw output persistence is off by default, opt-in history is size- and age-bounded, disabling it clears retained logs, and the settings surface provides explicit clearing. Browser-local presentation preferences never become terminal or process authority.
- Source, npm-release, direct-launch, and installed Linux service paths all include the daemon entrypoint and runtime dependencies. The installed terminal user service is separate from `inspire-host.service`; stopping or restarting only the Host leaves PTYs alive, while explicitly disabling the terminal service owns their shutdown.

## Non-goals

- Terminal splitting, simultaneous multi-writer input, anonymous sharing, and public terminal-only links are excluded.
- Pi prompts and Extensions do not implicitly inspect, type into, or execute a human terminal.
- Sixel, Kitty/iTerm image protocols, OSC 52 clipboard control, session recording, command replay after reboot, containers, and `tmux`-specific attachment remain optional future extensions rather than foundation behavior.
