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
command's start, not a browser command log. `terminal-output.ts` reads
buffer cell columns for both command ranges and whole-buffer copy: it includes
the first output line, excludes the next prompt, joins soft wraps, and distinguishes
wide-character margin padding from actual spaces. The view retires ranges on
snapshot replacement, column reflow, and display reset. Scrollback eviction retires markers as well. A real xterm 6
headless probe showed that `reset()` empties the current marker list without
setting old `IMarker.isDisposed` flags; reset paths therefore retire these ranges
explicitly rather than relying on that flag alone.

Browser checks exposed two additional interaction defects. Xterm's internal
search-decoration stacking layer could intercept overlay buttons; isolating its
stacking context keeps search/selection controls above it. Delayed clipboard
reads could paste after an A → B → A activation round trip. Clipboard completion
now checks the originating activation/control epoch, ignores retired errors, and
returns focus from the dismissed menu without stealing a newer focus choice.

## Text selection and touch input

Xterm's canvas selection is not native mobile text selection, and xterm clears it
when its row count changes. Command-output markers remain valid across height-only
changes, so they no longer share that invalidation rule.

`TerminalTextDialog` captures the active buffer once in a read-only textarea.
Native selection remains stable while the terminal receives output or resizes;
Select all and Copy work without command markers. The text is materialized only
when requested, rather than mirrored on every output event. The dialog reuses the
workbench's modal focus handling and copied-feedback hook.

Touch key pointer-down preserves the existing input focus, while the header's
keyboard button explicitly requests it. `terminal-input.ts` encodes modifier and
cursor-mode sequences for both text and touch keys. Paste clears pending modifiers
before entering xterm, and escape-sequence replies bypass the text-key latch.
The native textarea listens for selection changes directly: React's synthetic
selection event did not reliably update after touch selection.

## Verification

- Terminal-focused Vitest checks: **11 files, 136 tests passed**. Real-headless-
  xterm cases cover first-line/prompt boundaries, cell columns, Unicode and soft
  wraps, whole-buffer/alternate-screen copying, height-only resize, eviction,
  and retired ranges. Input tests cover modifier chords and application cursors.
- **4 Chromium terminal scenarios passed** against an isolated mock Host with
  real PTYs. They cover detach/takeover, multiple tabs, menu ownership and nested
  Escape, per-view search/output controls, clipboard copy, inert quoting, delayed
  clipboard ownership, focus restoration, and touch input/selection.
- The compact-control scenario checks 1280/390/320-pixel viewports, a 280-pixel-high
  panel, light/dark themes, bounded menus, and unchanged PTY dimensions while
  searching. Terminal-scoped axe checks pass in all six width/theme combinations;
  screenshots are produced as `output/playwright/terminal-compact-*.png` in the
  browser test workspace.
- Touch checks cover latched Ctrl, modified cursor keys, unmodified paste,
  direct Ctrl+C without input focus, native selection across a height change,
  and clipboard failure with the selection preserved. Layout/axe checks cover
  320-pixel portrait and 700-pixel landscape, simulated safe-area insets, reduced
  motion, light Amber and dark Jade. Screenshots use
  `output/playwright/terminal-text-*.png` in the browser test workspace.
- Typecheck, production web build, targeted Biome, unused-code, and whitespace
  checks passed.

Browser evidence uses Chromium touch emulation; native OS keyboard/selection UI
and other browser engines were not exercised.
