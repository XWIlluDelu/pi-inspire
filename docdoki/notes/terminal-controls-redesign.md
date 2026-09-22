# Compact terminal controls

## Design decision

The user delegated the terminal redesign and feature selection on 2026-09-22.
The terminal remains a shell inside the existing workbench, not a second command
manager. The binding contract is [[terminal]].

- One header keeps tabs, new/profile, connection/control state, search, focus,
  and More. No permanent second toolbar consumes output space.
- Selection exposes Copy and Add to chat; quoting still only fills the composer.
  Search is a viewport overlay, so opening it does not resize the PTY.
- More groups clipboard/output, display, and terminal management. One searchable
  all-project navigator replaces the separate global button and duplicate local
  terminal list. Low-frequency groups expand inline and scroll within the pane.
- Duplicate, browser command-history navigation, copying the previous command,
  and direct command reruns are removed. Native shell history remains available.
  Last-output copy, paste protection, explicit takeover, ordering, rename,
  restart/close confirmation, recent-close recreation, focused window, settings,
  and touch keys remain.

## Implementation boundaries

`TerminalView` portals only the active view's controls into `TerminalPane`; xterm
instances, streams, selections, and search state stay with their original view.
The shared header is not another owner of terminal state. Nested menu Escape
returns to its summary before closing the containing menu or narrow drawer.

Last-output copy retains the latest completed marker pair and the current
command's start, not a browser command log. `terminal-command-output.ts` reads
normal-buffer cell columns: it includes the first output line, excludes the next
prompt, joins soft wraps, and distinguishes wide-character margin padding from
actual spaces. The view retires ranges on snapshot replacement, resize/reflow,
and display reset. Scrollback eviction retires markers as well. A real xterm 6
headless probe showed that `reset()` empties the current marker list without
setting old `IMarker.isDisposed` flags; reset paths therefore retire these ranges
explicitly rather than relying on that flag alone.

Browser checks exposed two additional interaction defects. Xterm's internal
search-decoration stacking layer could intercept overlay buttons; isolating its
stacking context keeps search/selection controls above it. Delayed clipboard
reads could paste after an A → B → A activation round trip. Clipboard completion
now checks the originating activation/control epoch, ignores retired errors, and
returns focus from the dismissed menu without stealing a newer focus choice.

## Verification

- Terminal-focused Vitest checks: **10 files, 130 tests passed**. New real-headless-
  xterm cases cover first-line/prompt boundaries, cell columns, Unicode and soft
  wraps, ANSI rendering, alternate-screen isolation, eviction, and retired ranges.
- **3 Chromium terminal scenarios passed** against an isolated mock Host with
  real PTYs. They cover detach/takeover, multiple tabs, menu ownership and nested
  Escape, per-view search/output controls, clipboard copy, inert quoting, delayed
  clipboard ownership with a positive fresh-paste control, and focus restoration.
- The compact-control scenario checks 1280/390/320-pixel viewports, a 280-pixel-high
  panel, light/dark themes, bounded menus, and unchanged PTY dimensions while
  searching. Terminal-scoped axe checks pass in all six width/theme combinations;
  screenshots are produced as `output/playwright/terminal-compact-*.png` in the
  browser test workspace.
- Typecheck, production web build, format, lint, unused-code, and whitespace
  checks passed.

No daemon, transport protocol, or shell process ownership was changed. This
verification used Linux and Chromium, not native mobile devices or other browser
engines. The running Host was not restarted; unrelated lockfile changes were
preserved.
