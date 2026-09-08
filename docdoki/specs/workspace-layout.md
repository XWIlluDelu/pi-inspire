---
purpose: "The conversation retains usable reading geometry while session identity, Git observation, and responsive contextual panes keep independent presentation ownership."
covers:
  - src/App.tsx
  - src/store.ts
  - src/controllers/{git,workspace}-controller.ts
  - src/components/{AppTopbar,ContextPane,ContextSplitBody,FilesPane,ChangesPane,WorkspaceBrowser,BranchTree,PaneResizeHandle}.tsx
  - src/{git-presentation,use-modal-focus}.ts
  - src/styles/*.css
  - tests/web/{app,workspace-controller,pane-resize,branch-tree,modal-focus}.test.ts*
---

# Workspace layout and contextual panes

## Goal

Keep navigation, reading, and contextual work coherent across desktop and narrow layouts. Navigation
and startup are specified in [[workbench]], detailed resources in [[resource-preview]], and
independent project shells in [[terminal]].

## Checks

### Responsive reading and pane geometry

- The primary desktop layout provides stable regions for project/session navigation, conversation,
  and contextual work. A Prompt Map may occupy the conversation's own left reading margin and
  navigates only the current branch's user turns, so it neither joins project/session navigation nor
  duplicates contextual History. The desktop reading column always reserves the resting rail's
  minimum gutter from the center pane's actual width; window and side-pane resizing update both
  gutter and rail position before paint, so the rail never covers conversation content or retains an
  earlier-width position.

  On a narrow workbench, the floating rail is removed entirely: a top-right control floats over
  Transcript without reserving layout height, has no shared backdrop while its mutually exclusive
  Search and Prompt Map launchers are idle, and gives Search or the rotated Prompt Map a surface
  background when active in that same zone while retaining its complete temporary directory.

- The navigation and contextual regions can collapse so the conversation can use the available
  width. Below 900px, desktop rail preference is preserved but navigation itself becomes an
  independent off-canvas drawer below the center topbar; the fixed topbar toggle, internal close
  target, and scrim all dismiss it without horizontal overflow. Each open narrow drawer is exposed
  as a modal dialog, owns trapped and restorable focus through the central modal stack, and makes
  the center workbench inert; navigation and contextual drawers are mutually exclusive even when a
  file opens from inside navigation. The desktop surfaces retain their navigation and complementary
  landmarks. Opening a session also closes the drawer.

  Returning to desktop closes any transient drawer state without overwriting the user's desktop
  collapsed preference.

- Both side regions' widths are adjustable by dragging their boundary with the conversation
  (zero-width handles riding the shared edges), persist across reloads, and reset to the default on
  double-click; each boundary's scroll thumb keeps grab priority where the two overlap. A saved
  width is clamped live as the window narrows without overwriting the user's preference, then
  restored when space returns.

### Session identity and Git observation

- The topbar owns session identity — an explicit Pi name is the rename value, while an unnamed
  conversation presents its normalized first prompt (or `New session` before any prompt) without
  promoting that fallback into session metadata or OS-visible titles. The heading truncates
  responsively at its available width. Beside it, the project location appears as folder name or
  full path per a global preference, and clicking copies the absolute path without shifting layout.
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

  Actions stay fixed at the right: long status text ellipsizes with its full value available on
  hover, identity yields first, and no supported center width permits the clusters to overlap.
  Rename editing is owned by the session whose heading opened it; a switch cancels that editor, the
  submit carries the explicit session id rather than reading a newer visible selection, and a
  rejected rename leaves the current identity intact while emitting a non-blocking warning notice.

- Git status/diff request, cancellation, polling, and visible-surface scheduling belong to a bounded
  `GitController`. `AppStore` remains the sole snapshot publisher and executes the explicit
  cross-domain transition between a Git-selected path and a session-bound resource preview, so Git
  never becomes a parallel browser store.

### Workspace explorer and contextual modes

- The navigation column’s lower half offers a compact, collapsible workspace explorer labeled by the
  visible project basename. It intentionally omits search and secondary pane actions in the
  constrained column. Its lazy tree shares cwd-scoped expansion and selection with the right Files
  browser, and a file row opens the same session-bound preview as a conversation reference.

- The contextual region primarily hosts Files, Changes, History, and Terminal through equal-width
  mode controls that preserve every label at the pane's minimum width. Files uses the complete
  search/Recent/Workspace browser until a file is selected, then keeps a fixed bounded Workspace
  index above the file detail so related files remain one step away. Changes uses that same upper
  height, divider, and lower-header geometry without an internal resize control: repository identity
  and grouped changed paths stay above complete selected-file Source with inline Git changes and
  navigation. The same vertical hierarchy fills the contextual drawer on narrow screens rather than
  becoming a second component arrangement.

  History is an operational Pi branch/time-travel surface, not Git branch selection, a duplicate
  Transcript, or an audit-only raw log. It groups the bounded loaded entry tree by user turn, keeps
  a linear conversation on one rail, spends horizontal lanes only on actual alternate turn paths,
  and marks current, latest, and alternate state explicitly. Response activity is progressively
  disclosed beneath its prompt, with loaded-history search and global folding for inspection; exact
  actionable entries remain available for switching, while prompts retain Pi-authorized edit and
  fork actions. The center Transcript remains the authority for reading and searching full
  conversation content.

  Terminal presents the current project's ordered shell tabs without splits; hiding the pane
  detaches its views without ending PTYs, and focus mode or an independent same-origin window can
  temporarily give the selected terminal the viewport. The region remains in the three-column layout
  while that layout can preserve a usable conversation; below that floor it becomes a drawer
  starting under the center topbar, so it never covers its own open/close control.
