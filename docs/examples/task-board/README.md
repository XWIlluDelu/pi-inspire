# Source DIY: a task board

The Pi extension starts three cancellable thirty-second demo timers. The React view shows their
progress and sends commands back to the extension. Replace `run()` to drive your own tasks.

## Files and ownership

| File | Responsibility |
| --- | --- |
| [extension.ts](extension.ts) | Session-scoped state, native persistence, timers and namespaced commands. Stop/Retry operate the demo timer; Open notes uses Pi's normal editor dialog. |
| [types.ts](types.ts) | Small versioned data shape, decoder and command names shared by this example. |
| [TaskBoard.tsx](TaskBoard.tsx) | Props-only list/detail view with keyboard focus, status, summary, notes and capability-backed actions. It uses the shared [EmptyState](../../../src/components/EmptyState.tsx) when no snapshot is loaded. |
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

To try the board in the Files tab, edit [FilesPane.tsx](../../../src/components/FilesPane.tsx)
in your checkout. Import the adapter:

```tsx
import { TaskBoardAdapter } from "../../docs/examples/task-board/TaskBoardAdapter";
```

Inside `FileBrowser`, add `const [tasksOpen, setTasksOpen] = useState(false)` beside `showAll`.
Insert this section between Recent and the workspace tree:

```tsx
<section className="res__index-section">
  <button type="button" className="button button--quiet"
    aria-expanded={tasksOpen} onClick={() => setTasksOpen(open => !open)}>
    Tasks
  </button>
  {tasksOpen && <TaskBoardAdapter />}
</section>
```

Run the [development workbench](../../host.md#development-checkout), open Files and choose
**Tasks**. The adapter subscribes while the section is expanded. **Back to tasks** returns from a
task's detail view and restores focus to its row.

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
npm exec -- vitest run tests/server/task-board-example.integration.test.ts tests/web/command-ux.test.tsx tests/web/extension-ui-ownership.test.tsx
```
