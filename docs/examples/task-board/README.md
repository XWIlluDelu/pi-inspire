# Source DIY: a task board

This runnable example separates a Pi extension's behavior from its Web presentation. It starts
three cancellable thirty-second **demonstration timers**, not subagents or subprocesses. Replace
`run()` with your own workflow when you have a real execution capability. Inspire does not choose
your scheduling, tool permissions, retry policy, or agent architecture.

## Files and ownership

| File | Responsibility |
| --- | --- |
| [extension.ts](extension.ts) | Session-scoped state, native persistence, timers and namespaced commands. Stop/Retry operate the demo timer; Open notes uses Pi's normal editor dialog. |
| [types.ts](types.ts) | Small versioned data shape, decoder and command names shared by this example. |
| [TaskBoard.tsx](TaskBoard.tsx) | Props-only list/detail view with keyboard focus, status, summary, notes and capability-backed actions. |
| [TaskBoardAdapter.tsx](TaskBoardAdapter.tsx) | Read the selected session's newest admitted snapshot, check its command inventory, and dispatch prepared commands. |
| [task-board.css](task-board.css) | Existing Inspire typography, surface and spacing tokens; no second theme system. |

`Pi command → extension state → custom message details → normal Host projection → adapter → view`

`view action → adapter → sendPreparedCommand → native extension command → new snapshot`

The native JSONL branch owns persistence. On startup and Pi’s native `session_tree` event, the
extension clears local timers and restores only the selected branch’s latest snapshot. Interrupted
demo timers become Stopped, while that branch’s notes remain. Shutdown also clears timers.
Task work and outcomes come from snapshots, not from a browser send acknowledgement.
The adapter's pending state lasts only through command admission. Pi's editor dialog handles
Open notes until completion or cancellation.

The adapter reads only loaded messages. If the newest task snapshot has left that window,
**Show tasks** explicitly republishes the extension's current branch state. There is no hidden
full-history fetch, automatic command on selection, secondary task database or background index.

## Load the Pi extension

From your own checkout, use an absolute path:

```sh
pi install /absolute/path/to/inspire/docs/examples/task-board/extension.ts
```

Reload an idle owned session with Inspire's Reload, or use `/reload` in an external terminal
Pi. Existing external processes load code independently of Inspire. Trust and extension-loading
rules stay with the user's Pi.

The commands also work without changing the frontend:

- `/demo-tasks-start` — start the three demo timers.
- `/demo-tasks-show` — publish the current snapshot.
- `/demo-tasks-stop task-1` — stop one timer.
- `/demo-tasks-retry task-1` — retry it.
- `/demo-tasks-open task-1` — edit that task's notes through Pi's standard UI.

Stop and Retry are task capabilities, not replacements for Inspire's agent Stop.
The demo requires no model provider, credentials or network access.

## Mount the source UI

This is an opt-in checkout customization, not a runtime React plugin. The shipped application
does not gain a Tasks panel just by installing the extension.

For a small local integration, edit `src/components/ContextPane.tsx`:

1. Import the adapter and add a local toggle beside its other React state:

   ```tsx
   import { TaskBoardAdapter } from "../../docs/examples/task-board/TaskBoardAdapter";

   // Inside ContextPane:
   const [tasksOpen, setTasksOpen] = useState(false);
   ```

2. Add a visible toggle in `ctx__header-actions`:

   ```tsx
   <button type="button" className="button button--quiet"
     aria-pressed={tasksOpen} onClick={() => setTasksOpen(open => !open)}>
     Tasks
   </button>
   ```

3. Keep ordinary Files/Changes/History/Terminal clicks working by changing their existing handler:

   ```tsx
   onClick={() => {
     setTasksOpen(false);
     store.setContextMode(mode);
   }}
   ```

4. Prepend the task branch to the existing body conditional, retaining all the existing branches:

   ```tsx
   {tasksOpen ? (
     <div className="res__body"><TaskBoardAdapter /></div>
   ) : state.contextMode === "files" ? (
     // Existing FilesPane, followed by the unchanged Changes/History/Terminal branches.
   )}
   ```

The existing Context pane hosts the same list/detail component in the desktop column and mobile
full-height panel. **Back to tasks** returns from detail and restores row focus. This local toggle
is a demonstration mounting point; keep production panel placement and any additional browser-Back
levels with your layout owner rather than adding a second router.

Build with `npm run build`, serve that checkout through your development Host, and refresh the
browser. Follow your normal development launch workflow; do not rebuild a production-serving
checkout accidentally. Pi extension changes need native Reload; React/CSS changes need a rebuilt
frontend. Removing the source toggle restores the stock layout without migrating data.

## Verify your adaptation

- Start, stop and retry a task; open and cancel/save notes. Outcomes must come from the extension.
- Keep an unfinished draft and attachment, then use a task action: neither should be sent or cleared.
- Remove a command from the extension and Reload: its corresponding button must disable.
- Switch sessions or branch views: selected task, pending UI and errors must clear. In Pi History,
  navigate before the first task snapshot and use Show tasks: the new branch must have no old tasks.
  Return to a branch containing a saved task snapshot: its tasks and notes restore, with timers Stopped.
- Reload with a running demo: its timer stops, saved notes remain, and Show tasks reports Stopped.
- Check a narrow/short viewport, light/dark themes, keyboard focus and long task text.

The example is included in project type/lint checks. Its native command/dialog/reload and Web
inventory/draft-isolation regressions run with:

```sh
npm exec -- vitest run tests/server/task-board-example.integration.test.ts tests/web/command-ux.test.tsx tests/web/extension-dialog-content.test.tsx
```
