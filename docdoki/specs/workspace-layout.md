---
purpose: "The conversation retains usable reading geometry while session identity, Git observation, and responsive contextual panes keep independent presentation ownership."
covers:
  - src/App.tsx
  - src/use-inspection-history.ts
  - src/store.ts
  - src/controllers/{git,workspace}-controller.ts
  - src/components/{AppTopbar,Nav,NavigationToggle,SessionActionsMenu,Composer,ExtensionDisplays,ContextPane,ContextPaneShell,FilesPane,ChangesPane,FileIndexRow,WorkspaceBrowser,PaneResizeHandle}.tsx
  - src/{git-presentation,source-diff,use-modal-focus,use-session-action-reorder}.ts
  - server/git-inspection.ts
  - shared/contracts.ts
  - tests/integration/git-long-prefix.test.ts
  - tests/web/source-presentation.test.ts
  - src/styles/*.css
  - tests/web/{workspace-controller,pane-resize,modal-focus}.test.ts*
  - tests/browser/{composer,session-actions}.spec.ts
---

# Workspace layout and contextual panes

## Goal

Keep navigation, reading, and contextual work coherent across desktop and narrow layouts. Navigation
and startup are specified in [[workbench]], detailed resources in [[resource-preview]], and
independent project shells in [[terminal]].

## Responsive reading and pane geometry

- The desktop layout has stable regions for project/session navigation, conversation, and contextual
  work. Conversation search and the prompt outline launcher occupy the reading surface without
  reserving a toolbar row. The prompt outline opens as the same bounded dialog on desktop and
  narrow screens. The transcript scrollbar fits the trailing reading gutter.
  [[conversation]] owns search, prompt outline, and floating `Jump to latest` behavior.

- The navigation and contextual regions can collapse so the conversation can use the available
  width. Desktop navigation owns its toggle: the expanded header's right-hand control collapses it,
  and the rail logo expands it. The desktop conversation header has no duplicate toggle or reserved
  slot.

  Below 900px, navigation becomes an independent drawer opened from the topbar; the desktop rail
  preference is preserved. Its internal close button, Escape, and scrim dismiss it without
  horizontal overflow. Each open narrow drawer is a modal dialog: it owns trapped, restorable focus
  through the central modal stack and makes the center workbench inert. Navigation and contextual
  drawers are mutually exclusive, even when a file opens from inside navigation. Opening a session
  also closes the navigation drawer. The full-width context drawer needs no scrim. Desktop surfaces keep their
  navigation and complementary landmarks. Shared motion and overlay roles are in [[design-system]].

  The context pane keeps one shell and focus owner across deferred loading, content and failure;
  loading the module does not restart its entry animation. Its narrow header and Close control keep
  the same geometry across loading, ready and failure states.

  Returning to desktop closes transient drawer state without overwriting the desktop collapsed
  preference. Switching the contextual pane between desktop and drawer layouts keeps its reader or
  terminal mounted, preserving local interaction state. A dialog opened above either pane keeps
  focus and Escape ownership when a viewport change turns the underlying pane into a drawer; the
  lower drawer cannot trap focus or make that dialog inert.

- Automatic desktop widths are 220–240px for navigation (48px collapsed) and 340–760px for context. Navigation keeps its 460px manual maximum. Context can be manually widened up to the
  remaining shared conversation-width budget, with no separate fixed pixel ceiling; this does not
  change the automatic defaults.

  Each side region's width is adjusted by dragging its boundary with the conversation through a
  focusable handle with pointer and keyboard control. Widths persist across reloads, and
  double-click resets only the chosen side to its default. Each boundary's scroll thumb keeps grab
  priority where the two overlap. The two desktop side panes share a width budget that reserves
  400px for the conversation, or all remaining width after their 220px/320px minimums immediately
  above the drawer breakpoint. Resizing either side (pointer or keyboard) holds the other side at
  its current rendered width and clamps only the active side. A saved width is clamped live as the
  window narrows, without overwriting the user's preference, and restored when space returns.
  Window resizing and pane visibility changes reflow the saved preferences together without writing
  temporary widths back to storage.

  Desktop navigation and the right pane use 4px of frame-colored gutter whitespace, with no
  permanent divider. Desktop conversation and the complete context panel each have a subtle
  theme-aware 1px perimeter and 6px outer corners; navigation stays integrated with the shell, and
  narrow/mobile views have no added perimeter or radius. Both side boundaries keep 8px resize hit
  bands and hidden resting indicators. Hover, keyboard focus and active dragging reveal a straight
  2px divider with round caps and inset ends, not an outline around the adjacent pane's corners.
  The session header shares the reading surface without a separate bottom seam.

  Composer's model and thinking selectors follow the reading pane's actual width, not only the
  browser viewport. When side panes narrow the desktop conversation, selectors use the existing
  compact upper row; file/attachment actions, usage, and separate Stop/Send controls stay below in
  their existing order. Normal-width desktop panes keep the single-row toolbar, and narrow-screen
  startup composition keeps its existing responsive arrangement.

## Short-window input and extension content

File and terminal tabs share one strip with a searchable More tabs list for overflow.
The selected tab is brought into view. Arrow keys, Home and End navigate the strip. On compact
panes the tab strip gets its own row, keeping the selected tab and tools reachable. Opening,
closing, renaming and resizing preserve the underlying readers and terminal processes.
The strip renders file and terminal descriptors directly and uses the same descriptors for search.
Focused terminal windows use the same tab strip and keyboard navigation. Focused layout changes
which documents the strip lists and preserves the mounted terminal view.

Files, Changes and History use the same selection tint as open file and terminal tabs. The Terminal shortcut
creates a terminal. A pane at most 400px wide gives open tabs a second row when present.
File and terminal actions float over their content. PDF keeps its compact control row and reserves
clearance below the file actions in a narrow pane. Terminal search
and selection overlays stay within the output area.
Desktop HTML previews use the context perimeter instead of a second complete inner frame.

The Files search field starts 8px below contextual chrome with 12px horizontal insets. It uses the
shared search control and keeps its adjacent hidden-files control.

Files and Changes share the header height, section heading and list insets. The search and branch
summary use the same 8px top inset and 34px desktop or 40px narrow control area. The search field's
lower edge and the branch summary divider share a baseline, followed by 4px of space before the
24px section heading. At the top of either list, the heading, first file icon and filename align
when switching tabs. Both lists show the filename first and put its directory in secondary text.
Notices and conflict groups precede the ordinary Changes group when present.
Both lists reserve the same stable native-scrollbar gutter. Files uses a 12px break between Recent
and the workspace tree. In a compact Changes pane, renamed and copied paths put the destination
above the quieter origin and allow both to wrap so their directories stay distinguishable.
Recent, workspace search and Changes share the row layout, file icon and Git status marker. Each
row keeps the path context and action of its owning list.
Transcript and the complete Composer dock share the reading stage's height budget. A reading area
is preserved while the draft and Pi's aboveEditor/belowEditor widgets yield through their own
scrolling. Input text keeps its normal size; toolbars and Send/Stop keep their full targets. The
minimum editor line and focusable widget scrollports bound compression, including on touch and in
short landscape windows. Normal-height windows keep their spacing and natural widget heights.

Widgets keep an accessible label and place the visible Copy action alongside their text. In short
windows, each dock reserves room for the complete touch target and card padding. Transcript's
vertical breathing space belongs inside its scroll content, so it cannot push
the scrollport across the dock boundary. The editor's Expand/Collapse, selection, draft and
completion behavior are unchanged.

## Session identity and Git observation

- The topbar owns session identity. An explicit Pi name is the rename value. An unnamed
  conversation shows its normalized first prompt (or `New session` before any prompt); that
  fallback is never promoted into session metadata or OS-visible titles. The heading truncates at
  its available width. Beside it, the project location appears as folder name or full path per a
  global preference. On mobile, the location stays visible as text and truncates to fit.
  Clicking copies the absolute path, and Ctrl/⌘+click shows the project folder in the Host's file
  manager.

  A quiet clickable Git summary follows. It shows the current branch or detached/unborn identity,
  adds a total only when the worktree has changes, and opens the detailed Changes pane on
  activation. While the Changes pane is visible, the summary keeps the branch but omits its total,
  which Changes states beside the list. The summary is a first-class Git observation surface: it
  stays current while the contextual pane is closed. [[resource-preview]] defines when the workbench
  refreshes the summary, list and selected comparison.

  Only projection-conflict/recovery and extension status capsules occupy the leading cluster
  immediately after identity. The selected session's ordinary running, retrying and compacting
  state belongs to the composer (its semantic border/halo, Steer/Queue and Stop), with explicit
  state-owned retry/compaction text in the adjacent activity surface rather than command-owned
  progress copy.
  The narrow-layout navigation toggle and collapsed desktop rail's expand button share a count of
  other sessions with an unseen completion, failure or attention state. Completions use success tone;
  any failure or attention state takes error tone. The visible count caps at `9+`, while its accessible
  description retains the full count. On mobile, the badge slightly overlaps the icon's upper-right
  corner. On the desktop rail it sits in the clearance above the icon. The currently viewed session
  and running-only sessions are excluded. Consuming the last unseen state removes the badge. Expanded desktop navigation keeps
  its session-row indicators without a duplicate header badge. Both layouts preserve background
  outcome visibility when navigation hides the list, using text rather than color alone.

  Session title, project, Git and extension status form one leading cluster. Secondary labels
  truncate as space shrinks. A compact desktop header can hide the project label. On mobile,
  Git yields space to the project location by showing the branch glyph and numeric count.
  Git shows up to `99+` changes, with the exact change and conflict counts and branch in the
  accessible name. Truncated extension statuses remain available by click, tap or keyboard.
  Trailing actions keep their own space.

  Global controls stay on the right. Header actions are the command palette, Settings (desktop
  only) and the contextual pane toggle. Conversation search stays with its reading surface under
  [[conversation]], rather than adding a global header launcher. Narrow
  layouts reach Settings from the navigation drawer header and the palette, giving that width to
  session identity. Detailed Git status remains in Changes.

  The text-only title opens the session menu on desktop and phones, with no chevron or separate
  More control; hover feedback and a keyboard focus outline keep the interactive affordance. The
  menu sits below the title button with a compact 216px width, limited by available space rather
  than title length. Rename replaces the title with a focused input. Enter, Save or leaving the
  field commits the name, and Escape cancels. A session switch closes the editor.
  A delayed result keeps newer text in the field. A rejected rename leaves the current identity
  intact and reports the failure.

  **Switch branch…** opens the saved branch list inside the title menu. Choosing a branch applies [[session-persistence]]
  admission. The title menu shows all actions in the order saved under Behavior settings. Its
  grips support dragging, and Alt+Up/Down moves a focused action. The default order is Rename,
  Copy session ID, Clone, Switch branch and Export. The menu focuses the first enabled action and stays scrollable within the viewport. Arrows, Home/End, Enter and Escape
  operate it, and keyboard dismissal returns focus to the title.

  Copy session ID writes the complete selected Pi session ID, including for read-only history.
  Success shows ID copied in place; failure uses the existing copy-error notice and allows retry.
  Copy neither executes a session operation nor dismisses the menu. Export opens the shared
  format-and-download dialog without reading or changing the message draft. Clone shares History's
  readiness checks; refusal or failure leaves the menu open, and successful navigation closes it
  without stealing focus from a newer choice. `/clone` and the command palette reach the same
  endpoint-inclusive action. It creates an independent
  copy of the recorded active branch without sending a model prompt or changing the source's work,
  pending input or draft. [[session-branches]] defines native navigation, Fork/Clone boundaries and
  optional branch summaries.

## Contextual modes

- Workspace file browsing lives in the contextual Files pane; the session navigation column does
  not duplicate its tree. The right tool header uses the rail background with a fine boundary to the
  reader. Tabs and selected tool modes use one accent tint. Search fields, toolbars, authored documents
  and the terminal keep their own content-surface roles.

- Open files and project terminals have tabs on the leading side of the contextual header. Files,
  and Changes are fixed icon tabs on its trailing side, with hover titles and accessible
  names; the Terminal icon creates and activates a default terminal instead of selecting a nested
  terminal page. File, terminal and tool tabs share one content region. Files shows its complete
  search/Recent/Workspace browser; selecting a file opens or selects its sibling tab, with no
  nested Files layer or index/detail split. Returning to Files preserves its query, expansions and
  scroll. File tabs keep independent reader modes and Source/rendered scroll offsets;
  [[resource-preview]] defines the boundary for embedded readers and execution.

  The strip keeps the selected tab visible and lists the remaining overflow in More tabs. A
  choice restores focus to the newly visible tab. Terminal tabs can be reordered by dragging or
  with their keyboard shortcut. File and terminal controls float above the content. Interacting
  with the reading surface reduces the controls to their toggle. Keyboard Escape also collapses
  the controls and returns focus to that toggle.

  F5 restores the browser tab's navigation, pane widths and visibility, contextual tool, file-tab
  order and selection, and Files query and expansions. Saved session navigation is scoped to Host,
  session and workspace. Terminal reconnects to the existing selection. [[resource-preview]]
  defines how restored files regain read authority. The workbench shell shows loading until saved
  or continued session selection settles. An empty selection then shows the create-session screen.

  Changes always gives its grouped list the available height, with no Source split or selection
  hint. Selecting a comparison opens or reuses the ordinary file tab in Git Changes mode; Files
  opens that same tab in its body view. A compact toolbar above the preview
  holds, in order: Source/Preview, Git view, within-file previous/next navigation with its compact
  count, Copy path and trailing Download. Git view also offers Source to open the current file's
  source directly, keeping the tab and body reading state. Known unavailable/binary source stays
  disabled. An unread source can be requested. File tabs carry identity and Copy path exposes the
  full path. On narrow screens the toolbar can wrap to keep its touch targets available. File
  identity, view and independent reading offsets survive tab switches and F5 within the current
  session/workspace storage schema.
  [[resource-preview]] defines comparison authority and unavailable-content behavior.

  Narrow Context, navigation and Settings participate in transient browser history. File and tool
  tabs reuse one level, so Back closes the contextual drawer once. Explicit close consumes the
  owned level without leaving an empty Back stop. Image inspection uses the same small history
  owner, independently of panel depth; this is not a URL router or a second navigation model.
  Responsive panel history stays below a foreground image inspection when resizing adds or removes
  drawer levels. Back or Close ends the image first, then reconciles the panel levels without
  dismissing its content or leaving empty Back stops. Retired foreground markers cannot block a new
  drawer.

  Reading a branch does not change the Composer or occupy the contextual pane.

  Terminal presents the current project's ordered shell tabs without splits. After first access it
  stays mounted across file/tool tab switches, keeping its output and unfinished input; hidden
  terminal views neither steal focus nor resize the PTY. Closing the pane does not end PTYs. Focus
  mode or an independent same-origin window can temporarily give the selected terminal the
  viewport. The region stays in the three-column layout while that layout can preserve a usable
  conversation; below that floor it becomes a modal drawer with its own close control.

  The contextual header owns Refresh for the current mode. Files and Changes disable it without
  a selected session.
  Only a user-initiated refresh drives its busy icon and disabled state. Background observations
  update content quietly; their loading, stale-result and error states stay with the content.
  Manual feedback belongs to its session/transport/view and cannot overwrite a newer action.
