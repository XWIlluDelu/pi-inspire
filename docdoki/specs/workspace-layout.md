---
purpose: "The conversation retains usable reading geometry while session identity, Git observation, and responsive contextual panes keep independent presentation ownership."
covers:
  - src/App.tsx
  - src/use-inspection-history.ts
  - src/store.ts
  - src/controllers/{git,workspace}-controller.ts
  - src/components/{AppTopbar,Nav,NavigationToggle,SessionActionsMenu,Composer,ExtensionDisplays,ContextPane,ContextPaneShell,FilesPane,ChangesPane,WorkspaceBrowser,BranchTree,PaneResizeHandle}.tsx
  - src/{git-presentation,source-diff,use-modal-focus,use-session-action-reorder}.ts
  - server/git-inspection.ts
  - shared/contracts.ts
  - tests/integration/git-long-prefix.test.ts
  - tests/web/source-diff.test.ts
  - src/styles/*.css
  - tests/web/{app,navigation-attention,workspace-controller,pane-resize,branch-tree,modal-focus}.test.ts*
  - tests/browser/{composer,session-actions}.spec.ts
---

# Workspace layout and contextual panes

## Goal

Keep navigation, reading, and contextual work coherent across desktop and narrow layouts. Navigation
and startup are specified in [[workbench]], detailed resources in [[resource-preview]], and
independent project shells in [[terminal]].

## Responsive reading and pane geometry

- The desktop layout provides stable regions for project/session navigation, conversation, and
  contextual work. A Prompt Map may occupy the conversation's own left reading margin. It navigates
  only the current branch's user turns; it is not part of project/session navigation and does not
  duplicate contextual History. The desktop reading column always reserves the resting rail's
  minimum gutter from the center pane's actual width. Window and side-pane resizing update gutter and
  rail position before paint, so the rail never covers conversation content or keeps an
  earlier-width position.

  Search and navigation controls occupy the reading measure without reserving a toolbar row on
  desktop or narrow screens. Desktop conversation search stays in the top-right reading rail
  and sizes to the actual reader width. [[conversation]] owns search, Prompt Map and
  floating `Jump to latest` behavior. The transcript scroll thumb is separate from Prompt Map: its
  complete grab band fits the trailing reading gutter without covering content, and its travel stays
  inside the scrollport even in short windows. Native reading width, wheel and keyboard scrolling
  are unchanged.

  On a narrow workbench, Search and Prompt Map have launchers at the top-right of the transcript.
  The active tool uses that same zone without reserving layout height. The tools expand one at a
  time. The rotated Prompt Map keeps its complete temporary directory.
  [[conversation]] owns interaction details.

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

File and terminal tabs share one strip. Each tab has a 132px minimum for short titles and a 180px
cap for longer names, bounded by strip width, with matching close slots and label ellipsis. Excess
tabs are reachable through a trailing ellipsis that uses the existing dropdown's keyboard and modal
behavior. The selected tab stays visible, and selecting an overflow entry preserves the underlying
order. Opening, closing, renaming and resizing recompute the visible subset without unmounting
readers or terminal processes. If a focused tab control moves into overflow, focus follows to
More tabs. Compact pane spacing leaves room for a full tab and the overflow
trigger. Drawers up to 384px and desktop touch panes with up to 342px of content width put the
tab strip on its own row, keeping the selected tab, overflow and tool targets complete. Fine-pointer
desktop panes keep one row and tighten the tool widths at their minimum pane size.

Files/Changes/History use the same content-connected selected-tab background, top corners and fine
boundary as file/terminal tabs, with no additional accent underline. The Terminal shortcut remains
an action that creates a terminal. Inactive file hover surfaces share the 4px top corners.
Fine-pointer desktop headers stay 32px high through loading, empty and opened-tab states, so
creating the first tab does not move content or floating controls; narrow/touch targets keep their
existing size. Floating tools use 2px gaps within groups and 6px between action groups, with no
separator lines; terminal search/selection overlays share the tools' 8px/12px corner insets.
Desktop HTML previews use the context perimeter instead of a second complete inner frame.

Files and History search fields start 8px below contextual chrome with 12px horizontal insets. One
shared search-control rule owns their 34px desktop / 40px narrow height, surface, border, inner
padding and hover/focus states. Both keep `--text-sm` (12.5px) input and placeholder text and 13px
leading icons at every width; focus does not enlarge the text. Each owner keeps its own available
width, and Files keeps its adjacent hidden-files control.

Files uses one 4px search-to-heading gap and 24px section headings, keeping the 12px break between
Recent and workspace and the existing item heights. Changes section headings use the same 24px tier
and 12px text origin. The Changes branch-summary row uses the search row's 8px top inset and 34px
desktop / 40px narrow height, aligning Changes with Recent without an empty placeholder row. List
surfaces use a 4px outer inset plus their own content padding; both lists reserve the same stable
native-scrollbar gutter. In a compact Changes pane, renamed and copied paths put the destination
above the quieter origin and allow both to wrap so their directories stay distinguishable.
History's first turn has no duplicate top padding, even when Earlier
conversation or route navigation precedes it. Fine-pointer desktop History turns and prompts use
4px vertical padding; Activity keeps its full target, and multiline/current markers keep their
hierarchy. Earlier conversation is a compact secondary navigation control aligned to the 12px text
origin, with a 44px narrow/touch target. Hierarchical indentation, subsequent turn spacing and the
terminal's floating-search layout remain distinct.

Transcript and the complete Composer dock share the reading stage's height budget. A reading area
is preserved while the draft and Pi's aboveEditor/belowEditor widgets yield through their own
scrolling. Input text keeps its normal size; toolbars and Send/Stop keep their full targets. The
minimum editor line and focusable widget scrollports bound compression, including on touch and in
short landscape windows. Normal-height windows keep their spacing and natural widget heights.

In short windows, widget cards spend their height on text instead of repeating the generic
Extension heading; their accessible labels and Copy actions remain. Copy participates in the
compact widget row's height, and each dock reserves room for the complete touch target and card
padding. Transcript's vertical breathing space belongs inside its scroll content, so it cannot push
the scrollport across the dock boundary. The editor's Expand/Collapse, selection, draft and
completion behavior are unchanged.

## Session identity and Git observation

- The topbar owns session identity. An explicit Pi name is the rename value. An unnamed
  conversation shows its normalized first prompt (or `New session` before any prompt); that
  fallback is never promoted into session metadata or OS-visible titles. The heading truncates at
  its available width. Beside it, the project location appears as folder name or full path per a
  global preference, with no folder glyph; clicking copies the absolute path without shifting
  layout, and Ctrl/⌘+click shows the project folder in the Host's file manager.

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
  description retains the full count. The badge sits in the upper-right clearance of the navigation
  entrance, clear of the icon at either count width. The currently viewed session and running-only
  sessions are excluded. Consuming the last unseen state removes the badge. Expanded desktop navigation keeps
  its session-row indicators without a duplicate header badge. Both layouts preserve background
  outcome visibility when navigation hides the list, using text rather than color alone.

  Session title, project, Git and extension status form one left-aligned cluster with consistent
  spacing and a shared text baseline across the sans title and mono metadata/status; icons and
  global action buttons are centered independently. The project and Git identifiers form a tighter
  workspace subgroup beside the title. They have no resting background or frame; hover strengthens
  their text and keyboard focus keeps its outline. When the status slot is empty, identity can use
  the remaining header width instead of truncating beside unused reserved space; empty status takes
  no space. The Git label's width cap follows the header's available width. Nonempty status keeps
  its existing budget. Extension text uses the available space at
  every width, with full statuses available by click, tap or keyboard when truncated. Secondary
  project and Git details yield before the title and primary navigation. Trailing actions and
  inline rename keep their own layout.

  Global controls stay on the right. Header actions are the command palette, Settings (desktop
  only) and the contextual pane toggle. Conversation search stays with its reading surface under
  [[conversation]], rather than adding a global header launcher. Narrow
  layouts reach Settings from the navigation drawer header and the palette, giving that width to
  session identity. Detailed Git status remains in Changes.

  The text-only title opens the session menu on desktop and phones, with no chevron or separate
  More control; hover feedback and a keyboard focus outline keep the interactive affordance. The
  menu sits below the title button with a compact 216px width, limited by available space rather
  than title length. Rename opens the inline editor and is first in the default order. The inline
  rename input shares the title's leading edge, not the menu's width: it starts at 240px, grows with
  the displayed title up to 560px, and fits the available header space. On narrow bars it fills the
  remaining width while auxiliary header controls yield. Enter, the save control, or moving focus
  outside the editor saves the name; Escape cancels. Blank and unchanged edits exit without a write.
  Saving after focus leaves does not take focus back. The session whose heading opened the editor
  owns it: a session switch cancels it, the submit carries the explicit session id rather than
  reading a newer visible selection, and a rejected rename leaves the current identity intact while
  emitting a non-blocking warning notice.

  **Switch branch…** opens a submenu listing up to 30 most recent branch ends
  as radio items (latest user-message excerpt, relative age, Default marker, check for the viewed
  branch) behind a Back item, notes when History holds more, and is disabled with one branch.
  Choosing one applies [[session-persistence]] admission to it. The reorderable actions default to
  Rename, Copy session ID, Clone, Switch branch, and Export. Settings under Behavior edits the
  same order. The compact menu shows the first three actions. More
  actions reveals the rest in the same menu and Fewer actions collapses them; reopening starts
  compact. The menu opens with its first enabled action focused, and expansion focuses the first
  enabled newly revealed action. The full menu stays bounded and scrollable within the viewport.
  Arrows, Home/End, Enter and Escape operate it, and keyboard dismissal returns focus to the title.

  Each action, including one unavailable for execution, has a right-side drag handle. A mouse or
  touch drag previews the order and automatically reveals overflow; dropping inside the menu saves
  the same preference Settings uses. Escape, pointer cancellation or a drop outside the menu
  discards the preview. Grabbing or moving a handle never runs its session action. Handles are
  keyboard-reachable; Alt+Up/Down moves the focused action and keeps its focus.

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
  not duplicate its tree. The right tool header shares the navigation/titlebar rail background,
  with one weak 1px hairline separating it from the content below. The file tree, History and
  file-preview canvas share the main reading-stage background. Selected file/terminal tabs use that
  content surface with weak top/left/right edges, small top-only corners and an open bottom seam;
  desktop top corners join the frame squarely. Search fields, floating actions, authored documents
  and the terminal keep their own content-surface roles.

- Open files and project terminals have tabs on the leading side of the contextual header. Files,
  Changes and History are fixed icon tabs on its trailing side, with hover titles and accessible
  names; the Terminal icon creates and activates a default terminal instead of selecting a nested
  terminal page. File, terminal and tool tabs share one content region. Files shows its complete
  search/Recent/Workspace browser; selecting a file opens or selects its sibling tab, with no
  nested Files layer or index/detail split. Returning to Files preserves its query, expansions and
  scroll. File tabs keep independent reader modes and Source/rendered scroll offsets;
  [[resource-preview]] defines the boundary for embedded readers and execution.

  Overflowing file/terminal tabs move into the strip's trailing overflow menu (see Short-window
  input above) while the tool actions remain available. Filename tabs fill the header height, starting flush at its leading content edge, with
  internal label spacing instead of floating rounded backgrounds. Title and close action share one
  continuous tab background; close hover changes only its icon ink, and keyboard focus uses a thin
  outline. Selection indicators remain. File-specific and terminal controls float over their own
  content instead of adding another full-width toolbar row. Deferred loading preserves the header
  geometry without a legacy Context title; loading and actionable failure feedback stay in the
  content area.

  F5 restores the browser tab's navigation, pane widths and visibility, contextual tool, file-tab
  order and selection, and Files query and expansions. Saved session navigation is scoped to Host,
  session and workspace. Terminal reconnects to the existing selection. [[resource-preview]]
  defines how restored files regain read authority. The workbench shell shows loading until saved
  or continued session selection settles. An empty selection then shows the create-session screen.

  Changes always gives its grouped list the available height, with no Source split or selection
  hint. Selecting a comparison opens or reuses the ordinary file tab in Git Changes mode; Files
  opens that same tab in its body view. A compact floating action group at the preview's top-right
  holds, in order: Source/Preview, Git view, within-file previous/next navigation with its compact
  count, Copy path and trailing Download. Git view also offers Source to open the current file's
  source directly, keeping the tab and body reading state. Known unavailable/binary source stays
  disabled; a not-yet-read source can be requested. There is no separate path/header row, including
  on narrow readers; file tabs carry identity and Copy path exposes the full path. The group
  overlays the normal reading canvas without reserving a full-width top band. Direct reading input
  collapses it to an explicit entry; programmatic scrolling/restoration does not. The entry expands
  the controls, and Escape collapses them while keeping keyboard focus. Narrow/touch targets remain
  available; local wrapping avoids shrinking them. File identity, view and independent
  reading offsets survive tab switches and F5 under the existing session/workspace storage scope.
  [[resource-preview]] defines comparison authority and unavailable-content behavior.

  Narrow Context, navigation and Settings participate in transient browser history. File and tool
  tabs reuse one level, so Back closes the contextual drawer once. Explicit close consumes the
  owned level without leaving an empty Back stop. Image inspection uses the same small history
  owner, independently of panel depth; this is not a URL router or a second navigation model.
  Responsive panel history stays below a foreground image inspection when resizing adds or removes
  drawer levels. Back or Close ends the image first, then reconciles the panel levels without
  dismissing its content or leaving empty Back stops. Retired foreground markers cannot block a new
  drawer.

  History is a conversation outline for inspecting and deliberately continuing Pi history, not a
  graph editor, duplicate Transcript, or raw audit log. User prompts lead its compact default view;
  reply/event detail and alternate routes are disclosed where relevant. Other starts also exposes
  branch points in a hidden metadata-only prefix, keeping first-input alternatives reachable.
  Selecting a point previews its complete content inside History without changing Pi's active
  context or the Composer. Returning to the outline preserves search, loaded history, scroll and
  focus. Opening an alternate route reveals its chosen/latest point, not its shared oldest
  ancestor; returning to Current conversation only restores the active conversation's outline.
  Exact node actions distinguish editing/continuing in this session from creating an independent
  Fork or Clone, without an action toolbar on every outline row. Search reaches complete retained
  history across branches, and older points stay reachable through progressive loading; bounded
  responses never limit accessible history. The center Transcript remains the active conversation
  surface.

  On a narrow screen, a successful context-changing action closes the modal contextual drawer to
  reveal the resulting conversation/draft; read-only preview and Back keep it open.

  Terminal presents the current project's ordered shell tabs without splits. After first access it
  stays mounted across file/tool tab switches, keeping its output and unfinished input; hidden
  terminal views neither steal focus nor resize the PTY. Closing the pane does not end PTYs. Focus
  mode or an independent same-origin window can temporarily give the selected terminal the
  viewport. The region stays in the three-column layout while that layout can preserve a usable
  conversation; below that floor it becomes a modal drawer with its own close control.

  The contextual header owns Refresh for the current mode, including History. Files, Changes, and
  History disable it without a selected session; History also disables it during a branch action.
  Only a user-initiated refresh drives its busy icon and disabled state. Background observations
  update content quietly; their loading, stale-result and error states stay with the content.
  Manual feedback belongs to its session/transport/view and cannot overwrite a newer action.
