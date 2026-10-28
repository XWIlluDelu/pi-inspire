---
purpose: "The conversation retains usable reading geometry while session identity, Git observation, and responsive contextual panes keep independent presentation ownership."
covers:
  - src/App.tsx
  - src/use-inspection-history.ts
  - src/store.ts
  - src/controllers/{git,workspace}-controller.ts
  - src/components/{AppTopbar,SessionActionsMenu,Composer,ExtensionDisplays,ContextPane,ContextPaneShell,FilesPane,ChangesPane,WorkspaceBrowser,BranchTree,PaneResizeHandle}.tsx
  - src/{git-presentation,source-diff,use-modal-focus,use-session-action-reorder}.ts
  - server/git-inspection.ts
  - shared/contracts.ts
  - tests/integration/git-long-prefix.test.ts
  - tests/web/source-diff.test.ts
  - src/styles/*.css
  - tests/web/{app,workspace-controller,pane-resize,branch-tree,modal-focus}.test.ts*
  - tests/browser/{composer,session-actions}.spec.ts
---

# Workspace layout and contextual panes

## Goal

Keep navigation, reading, and contextual work coherent across desktop and narrow layouts. Navigation
and startup are specified in [[workbench]], detailed resources in [[resource-preview]], and
independent project shells in [[terminal]].

## Responsive reading and pane geometry

- The primary desktop layout provides stable regions for project/session navigation, conversation,
  and contextual work. A Prompt Map may occupy the conversation's own left reading margin and
  navigates only the current branch's user turns, so it neither joins project/session navigation nor
  duplicates contextual History. The desktop reading column always reserves the resting rail's
  minimum gutter from the center pane's actual width; window and side-pane resizing update both
  gutter and rail position before paint, so the rail never covers conversation content or retains an
  earlier-width position.

  Search and navigation controls occupy the reading measure without reserving a toolbar row on
  desktop or narrow screens. [[conversation]] owns the inline desktop search, narrow launchers and
  floating `Jump to latest` behavior.
  The transcript scroll thumb is separate from Prompt Map: its complete grab band fits the
  trailing reading gutter without covering content, and its travel stays inside the scrollport
  even in short windows. Native reading width, wheel and keyboard scrolling remain unchanged.

  On a narrow workbench, the floating rail is removed entirely: a top-right control floats over
  Transcript without reserving layout height, has no shared backdrop while its mutually exclusive
  Search and Prompt Map launchers are idle, and gives Search or the rotated Prompt Map a surface
  background when active in that same zone while retaining its complete temporary directory.
  [[conversation]] owns interaction details.

- The navigation and contextual regions can collapse so the conversation can use the available
  width. Desktop navigation owns its toggle: the expanded header's right-hand control collapses
  it, and the rail logo expands it. The desktop conversation header has no duplicate toggle or
  reserved slot. Below 900px, desktop rail preference is preserved but navigation itself becomes an
  independent drawer opened from the topbar. Its internal close button, Escape, and scrim dismiss
  it without horizontal overflow. Each open narrow drawer is exposed
  as a modal dialog, owns trapped and restorable focus through the central modal stack, and makes
  the center workbench inert; navigation and contextual drawers are mutually exclusive even when a
  file opens from inside navigation. The desktop surfaces retain their navigation and complementary
  landmarks. Opening a session also closes the drawer. The context pane keeps one shell and focus
  owner across deferred loading, content and failure; loading the module does not restart its entry
  animation. Its narrow header and Close control keep the same geometry across loading,
  ready and failure states. The full-width context drawer needs no scrim. Shared motion and overlay roles are in
  [[design-system]].

  Returning to desktop closes transient drawer state without overwriting the desktop collapsed
  preference. Switching the contextual pane between desktop and drawer layouts keeps its reader or
  terminal mounted, preserving local interaction state. A dialog opened above either pane keeps
  focus and Escape ownership when a viewport change turns the underlying pane into a drawer;
  the lower drawer cannot trap or make that dialog inert.

- Automatic desktop widths use 220–272px for navigation (48px collapsed) and 340–760px for context.
  Navigation retains its 460px manual maximum. Context can be manually widened to the remaining
  shared conversation-width budget, without a separate fixed pixel ceiling; automatic defaults
  do not change.
  Both side regions' widths are adjustable by dragging their boundary with the conversation
  using focusable handles with pointer and keyboard control, persist across reloads, and reset to
  the default on double-click; each boundary's scroll thumb keeps grab priority where the two
  overlap. A saved width is clamped live as the window narrows without overwriting the user's
  preference, then restored when space returns. The two desktop side panes share a width budget
  that reserves 400px for the conversation, or all remaining width after their 220px/320px
  minimums immediately above the drawer breakpoint. Resizing either side (pointer or keyboard)
  holds the other side at its current rendered width and clamps only the active side. Window
  resizing and pane visibility changes reflow the saved preferences together; they do not write
  temporary widths back to storage. Double-click resets only the chosen side.
  Desktop panes are separated by 4px gutters
  with 8px resize hit bands. Hover, keyboard focus and active dragging reveal a straight 2px
  divider with round caps and inset ends, not an outline wrapping the adjacent pane's corners.
  The session header shares the reading surface without a separate bottom seam.

  Composer's model and thinking selectors follow the reading pane's actual width, not only the
  browser viewport. When side panes narrow the desktop conversation, selectors use the existing
  compact upper row; file/attachment actions, usage, and separate Stop/Send controls stay below in
  their existing order. Normal-width desktop panes retain the single-row toolbar and narrow-screen
  startup composition keeps its existing responsive arrangement.

## Short-window input and extension content

Transcript and the complete Composer dock share the reading stage's height budget. Preserve a reading
area while the draft and Pi's aboveEditor/belowEditor widgets yield through their own scrolling.
Input text keeps its normal size; toolbars and Send/Stop retain their full targets. The minimum
editor line and focusable widget scrollports bound compression, including touch and short landscape
windows. Normal-height windows retain their spacing and natural widget heights.

In short windows, widget cards spend their height on text rather than repeat the generic Extension
heading; their accessible labels and Copy actions remain. Transcript's vertical breathing space
belongs inside its scroll content, so it cannot force the scrollport across the dock boundary.
The editor's existing Expand/Collapse, selection, draft and completion behavior remain intact.

## Session identity and Git observation

- The topbar owns session identity — an explicit Pi name is the rename value, while an unnamed
  conversation presents its normalized first prompt (or `New session` before any prompt) without
  promoting that fallback into session metadata or OS-visible titles. The heading truncates
  responsively at its available width. Beside it, the project location appears as folder name or
  full path per a global preference, without a redundant folder glyph; clicking copies the absolute
  path without shifting layout.
  A quiet clickable Git summary follows: it shows the current branch or detached/unborn identity,
  adds a total only when the worktree has changes, and opens the detailed Changes pane on
  activation.

  It is a first-class Git observation surface, so this small summary stays current even while the
  contextual pane is closed; detailed paths and diffs remain there. Its automatic scheduler uses a
  low 20-second cadence when this compact summary is the only observer, retains a four-second
  cadence while a detailed Git surface is open, and pauses while the page is hidden; returning to a
  visible page, tool completion, and explicit refresh trigger an immediate coalesced observation, so
  a slow repository cannot create a continuous child-process loop. Only projection-conflict/recovery
  and extension status capsules remain in the leading cluster immediately after identity; ordinary
  running, retrying, compacting, and failed feedback belongs to the composer’s semantic border/halo,
  with explicit state-owned retry/compaction text in the adjacent activity surface rather than
  command-owned progress copy.

  Session title, project, Git and extension status form one left-aligned cluster with consistent
  spacing and a shared text baseline across the sans title and mono metadata/status; icons
  and global action buttons remain centered independently. The project and Git identifiers form
  a tighter workspace subgroup beside the title,
  and global controls remain on the right. Workspace identifiers have no resting background or frame;
  hover strengthens their text and keyboard focus retains its outline. The text-only title opens
  the session menu on both desktop and phones, with no chevron or separate More control.
  Its hover feedback and keyboard focus outline retain the interactive affordance.
  Rename opens the inline editor and is first in the default order. Extension text uses the available
  space at every width, with full statuses
  available by click, tap or keyboard when truncated. No status takes no space. Secondary project and
  Git details yield before the title and primary navigation. Narrow layouts retain Settings in the
  header; detailed Git status remains in Changes. The session menu sits below the title button with a
  compact 216px width, limited by available space rather than title length. The inline rename
  input shares the title's leading edge, not the menu's width: it starts at 240px, grows with the
  displayed title up to 560px, and fits the available header space. On narrow bars it fills the
  remaining width while auxiliary header controls yield.
  Enter, the save control, or moving focus outside the editor saves the name; Escape cancels.
  Blank and unchanged edits exit without a write. Saving after focus leaves does not take focus back.
  Rename editing is owned by the session whose heading opened it; a switch cancels that editor, the
  submit carries the explicit session id rather than reading a newer visible selection, and a
  rejected rename leaves the current identity intact while emitting a non-blocking warning notice.

  The title menu defaults to Rename, Copy session ID, Clone, Use in terminal, and Export, with order
  configurable in Settings under Behavior. It initially shows the first three actions; More actions
  reveals the rest in the same menu, and Fewer actions collapses them. Reopening starts compact.
  Expansion focuses the first enabled newly revealed action; the full menu remains bounded and
  scrollable within the viewport. The menu opens with its first enabled action focused; arrows,
  Home/End, Enter and Escape operate it, and keyboard dismissal returns focus to the title.
  Each action has a right-side drag handle, including actions unavailable for execution. A mouse
  or touch drag previews the order and automatically reveals overflow; dropping inside the menu
  saves the same preference used by Settings. Escape, pointer cancellation or a drop outside the
  menu discards the preview. Grabbing or moving a handle never runs its session action.
  Handles remain keyboard-reachable; Alt+Up/Down moves the focused action and retains its focus.

  Copy session ID writes the complete selected Pi session ID, including for read-only history.
  Successful clipboard completion shows ID copied in place; failure uses the existing copy-error
  notice and allows retry. Copy does not execute a session operation or dismiss the menu.
  Export opens the shared format-and-download dialog without reading or changing the message draft.
  Clone shares History's readiness checks. Refusal or failure leaves the menu open; successful
  navigation closes it without stealing focus from a newer choice.
  `/clone`, the command palette and the earlier-branch notice's `Clone from here` reach the same
  endpoint-inclusive action. It creates an independent copy of the recorded active branch without
  sending a model prompt or changing the source's work, pending input or draft. [[session-branches]]
  defines native navigation, Fork/Clone boundaries and optional branch summaries.

- Git status and diff observations share a bounded scheduler and the workbench's snapshot authority.
  Selecting a Git path and opening its session-bound resource preview form one cross-domain transition;
  Git does not maintain a parallel browser store. While Changes is visible, status observations also
  refresh its selected file and side. Polling, Pi tool completion, terminal command completion and explicit
  Refresh share that inspection path. One active read and one queued refresh coalesce repeated hints;
  slow reads do not overlap polling. Keep the previous source readable until its replacement is ready,
  preserve the selected path/side and reader offsets, and reuse unchanged results. A failed refresh
  retains the source with a visible stale-result notice; a successful read clears it.

  Keep complete selected-file source when it fits the bounded projection. If unchanged context exhausts
  that budget, reread bounded changed regions instead of hiding the edits behind a long prefix. Mark omitted context separately from a
  truncated diff. Syntax highlighting has its own bounded complete-revision context; validate it
  against displayed rows and use literal escaped text when unavailable or changed between reads.

## Contextual modes

- Workspace file browsing lives in the contextual Files pane; the session navigation column does
  not duplicate its tree.
  The right shell, tool header and file tree share the navigation/titlebar rail background. Desktop
  top corners join that frame squarely; file bodies, search fields and other content surfaces keep
  their existing separate background roles.

- Open files have filename tabs on the leading side of the contextual header. Files, Changes,
  History, and Terminal remain fixed icon tabs on its trailing side, with hover titles and
  accessible names. All are same-level selections sharing one content region. Files shows its
  complete search/Recent/Workspace browser; selecting a file opens or selects its sibling tab,
  without a nested Files layer or index/detail split. Returning to Files preserves its query,
  expansions and scroll. File tabs retain independent reader modes and Source/rendered scroll
  offsets; [[resource-preview]] defines the boundary for embedded readers and execution.
  Overflowing filename tabs scroll within their own strip while the tool tabs remain available.
  Filename tabs fill the header height, starting flush at its leading content edge, with internal
  label spacing rather than floating rounded backgrounds. Title and close action share one continuous
  tab background; close hover changes only its icon ink, and keyboard focus uses a thin outline.
  The tab strip has no full-width bottom rule: its warm surface meets the selected view directly,
  while file paths and tool content retain their own local boundaries. Selection indicators remain.
  F5 keeps the current browser tab's navigation collapse, context visibility, file-tab order and
  selection, tool selection, and Files query/expanded directories. Existing saved pane widths remain
  in use. Session-specific state is scoped to the Host, session and workspace, and file content is
  loaded again under current authority. Terminal restores its existing selection and reconnects;
  restoring the view never reruns a command. Embedded readers retain the limits in [[resource-preview]].
  Initial bootstrap and saved/continue-session selection keep a lightweight loading state in the
  workbench shell. The create-session screen appears only after restoration settles without a
  session; missing sessions and failed reads retain their normal error and recovery paths.
  Transport replacement revokes old content handles and pending reads while retaining navigation
  metadata. Tool changes during reconnect must not overwrite saved file tabs with temporary empty
  state; the latest navigation intent survives success or retry without exposing old file content.

  Changes always uses the available height for its grouped list, without a Source split or
  selection hint. Selecting a comparison opens or reuses the ordinary file tab in Git Changes
  mode. Files opens that same tab in its body view. The file toolbar owns comparison-side selection,
  counts and within-file previous/next change navigation; Download stays trailing. Source/Preview
  remains a body-only reciprocal action. Narrow readers use a path row and an action row in both
  modes rather than squeezing the path out of the toolbar. File identity, view, side and independent
  reading offsets survive tab switches and F5 under the existing session/workspace storage scope.
  [[resource-preview]] defines comparison authority and unavailable-content behavior.

  Narrow Context, navigation and Settings participate in transient browser history. File and tool
  tabs reuse one level, so Back closes the contextual drawer once. Explicit close consumes the
  owned level without an empty Back stop. Image inspection uses the same small history owner,
  independently of panel depth; this is not a URL router or a second navigation model.

  History is a conversation outline for inspecting and deliberately continuing Pi history, not a
  graph editor, duplicate Transcript, or raw audit log. User prompts lead its compact default view;
  reply/event detail and alternate routes are disclosed where relevant. Other starts also exposes
  branch points in a hidden metadata-only prefix, keeping first-input alternatives reachable.
  Merely selecting a point
  previews its complete content inside History without changing Pi's active context or the Composer.
  Returning to the outline preserves search, loaded history, scroll and focus. Opening an alternate
  route reveals its chosen/latest point, not its shared oldest ancestor; returning to Current
  conversation only restores the active conversation's outline. Exact node actions explicitly distinguish
  editing/continuing in this session from creating an independent Fork or Clone, without an action
  toolbar on every outline row. Search reaches complete retained history across branches, and older
  points remain reachable through progressive loading; bounded responses never define the limit of
  accessible history. The center Transcript remains the active conversation surface.

  On a narrow screen, a successful context-changing action closes the modal contextual drawer to
  reveal the resulting conversation/draft; read-only preview and Back keep it open.

  Terminal presents the current project's ordered shell tabs without splits. After first access,
  switching file/tool tabs keeps it mounted, retaining its output and unfinished input; hidden
  terminal views neither steal focus nor resize the PTY. Closing the pane does not end PTYs,
  and focus mode or an independent same-origin window can
  temporarily give the selected terminal the viewport. The region remains in the three-column layout
  while that layout can preserve a usable conversation; below that floor it becomes a modal drawer
  with its own close control.

  The contextual header owns Refresh for the current mode, including History. Files, Changes, and
  History disable it without a selected session; History also disables it during a branch action.
