# Adapting Pi extensions to Inspire

Pi loads your extensions and owns their tools, commands, state and lifecycle; Inspire shows their
RPC-visible data in the browser. Install extensions through Pi's normal configuration first:
presentation files and adapter toggles change only how Inspire displays them.

Inspire ships native cards for `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find` and
`ls`; other tools get generic cards with arguments, output, images and structured details. Inspire
also loads an internal GUI bridge (branch navigation, model-catalog refresh, retry settings and
authentication) that adds no model tools.

For an end-to-end example, run the [native UI extension](#try-the-native-ui-example).
For custom tool cards and status controls, see [tool presentations](tool-presentations.md).
The [task-board example](https://github.com/XWIlluDelu/pi-inspire/tree/main/docs/examples/task-board)
shows how to add a React view in a source checkout.

## What works through RPC

| Extension feature | Browser behavior | Adaptation |
| --- | --- | --- |
| `registerCommand()` | Command palette and Composer `/` completion. | Use for occasional actions. Native command names take precedence; namespaced commands avoid collisions. |
| `registerTool()` | Runs in Pi and receives a native, configured, or generic card. | Add a presentation rule for a useful stable data shape. |
| `select`, `confirm`, `input`, `editor` | Shared keyboard, pointer, and touch dialogs after worker startup. | Move interactive setup into a command. See [startup](#startup) and the [permission example](#permission-prompt). |
| `notify` | Transient notice. | Use for completion, warning, or failure. |
| `setStatus` | Compact top-bar status at every screen width; click, tap or use the keyboard to read full status text. Retained up to 1,024 characters, restored on reconnect, cleared with the worker. | Keep the main fact short; full retained text remains readable on demand. |
| `setWidget(key, string[], options)` | Supplied text and Copy above or below Composer, without a key-derived heading. Reusing a key replaces it; `undefined` clears it. | See the [Todo widget](#todo-widget) and [usage footer](#usage-footer). |
| `setWidget(key, componentFactory)` | Ignored by Pi in RPC mode. | Supply a string-array branch for RPC. |
| `setTitle` | Browser document title. | Treat it as transient session presentation. |
| `setEditorText`, `pasteToEditor` | Replace the Composer draft; RPC paste does not insert into existing text. | Use for a complete replacement, not an append. |
| `getEditorText`, `getEditorComponent` | Return `""` and `undefined` in Pi RPC. | Ask for text through `input` or `editor` instead of reading the browser draft. |
| `custom()` | Returns `undefined` in RPC mode. | Use standard dialogs or commands. |
| `setFooter`, `setHeader`, `setEditorComponent`, `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`, `setHiddenThinkingLabel`, `setToolsExpanded` | No-ops in Pi RPC; `getToolsExpanded()` returns `false`. | Present the information as status, a widget, or a command. |
| `getAllThemes`, `getTheme`, `setTheme` | Return `[]`, `undefined`, and an unsupported result respectively in Pi RPC. | Browser theme preferences belong to Inspire Settings. |
| `addAutocompleteProvider()` and command argument-completion callbacks | Not exposed through Pi RPC. | Generic extension argument completion remains unimplemented. |
| TUI message/tool renderers | Terminal components are not serialized. | Keep the TUI renderer and add a Web projection. |
| `registerShortcut()` and terminal input handlers | No browser shortcut is created. | Expose a command first; a Web shortcut needs source-level focus/conflict handling. |

Branch on `ctx.mode`, not `ctx.hasUI`: both TUI and RPC report UI availability.

Select uses ArrowUp/ArrowDown to move the visible choice and Enter to choose; clicking or tapping
chooses directly. Confirm shows No and Yes, with Escape cancelling. Input submits with Enter;
multiline editor text is saved with Save. Timed dialogs quietly show remaining time from the retained
deadline, so reopening or reconnecting does not restart it. Untimed dialogs show no countdown.
On phones, browser Back cancels the active question before closing the panel behind it. A pending
or failed cancellation stays visible; a failed request can be retried.

Dialog timeouts dismiss the browser request. When Stop retains the worker, Inspire sends native
`cancelled: true` responses to the pending questions before removing them; cancelling is not merely
hiding a dialog. A new independent question created during cancellation stays answerable. Worker
retirement clears its remaining browser requests. An extension's own `AbortSignal` can resolve a
dialog without sending a browser-dismissal event (also observed in Pi 1.3.0), so that
request can remain visible until answered or cleared by Inspire. The public `ui_prompt_end` callback
reports aggregate waiting and has no dialog ID; it cannot safely dismiss one of several concurrent
dialogs. Inspire does not infer cancellation from idle state or command completion.

## Startup

RPC startup must finish before Pi can consume a dialog response. Awaiting `select`, `confirm`, `input`, or `editor` in `session_start` therefore fails with `PI_STARTUP_RESPONSE_UI_UNSUPPORTED`, and Inspire stops that worker. Startup notices, status, and text widgets work.

When Pi reports an extension-load failure, Inspire identifies the failed file with repair/disable
guidance. Raw exception details remain in the Host console log. Invalid-settings warnings similarly
identify the file to repair. A native trust warning explains when this worker skips trust-protected
project settings and resources; use terminal Pi's `/trust`, then Reload this session. This is not a
complete resource inventory: invalid-skill omission diagnostics are not exposed by Pi RPC.

For interactive setup, register a command and advertise it in a startup notice or widget. The command can open dialogs once the worker is ready. Retain the existing interactive startup path in TUI mode if needed.

Extension factories also run during prospective-workspace model discovery, without `session_start`
or a persistent session. Register capabilities there; start processes, watchers and timers from
`session_start` or the command/tool that needs them, and release them in an idempotent
`session_shutdown` handler.

## Session lifecycle

Inspire-owned sessions use independent workers rather than switching one TUI process between every
conversation. A terminal Pi you take over keeps its own process; see [sharing sessions](#share-sessions-with-terminal-pi).

| GUI action | Extension lifecycle |
| --- | --- |
| Select a conversation | Changes the browser view. A cached worker keeps running; selection does not call its `session_before_switch` or rerun `session_start`. Starting or restoring a worker runs normal startup. |
| New session | Starts an independent worker. |
| Browser `/reload` | Replaces only the selected idle Inspire-owned worker; the replacement runs normal extension startup. |
| Extension-triggered native reload | Keeps the RPC worker. At Pi's reload startup boundary, Inspire clears prior statuses and text widgets, including shutdown updates, before retaining the new startup values. |
| Navigate within a session tree | Uses Pi's `navigateTree` operation and native hooks through the internal command bridge. |
| Fork / Clone | Copies a verified snapshot through Pi's `SessionManager` into a separate session. Fork excludes the selected input; Clone includes its endpoint. Source `session_before_fork` / `session_fork` hooks do not run and cannot veto either copy. Persisted extension entries follow Pi branch semantics; process memory and pending dialogs stay with the source. The destination loads extensions during startup. |

Keep state scoped to its Pi session and reconstruct it from persisted entries during `session_start` where appropriate. An extension relying on source-runtime switch/fork hooks needs to account for these GUI actions separately.

## Share sessions with terminal Pi

Install [attach-control](../extensions/attach-control.ts) to share a terminal Pi with Inspire:

```sh
pi install /absolute/path/to/inspire/extensions/attach-control.ts
```

New Pi processes load it automatically. Run `/reload` in an existing idle terminal Pi.
Inspire attaches automatically when one idle, controllable Pi is continuing the viewed branch.
If that Pi is busy, **Take over** connects the browser to the running task. Both interfaces can
send input, stop the task, rename the session or change its model and thinking level. If several
processes match the viewed branch, leave the session in the others before taking over.

**Input during a run.** Start `inspire pi` in the project directory to use Steer and Follow up
from the browser. To resume a session, use `inspire pi --session <session.jsonl>`. Relative
paths start in the calling directory. From another project with a source installation, invoke
`node /path/to/inspire/inspire.mjs pi` there. This terminal uses Pi's native UI, saved trust,
model scope and built-in MCP. Pi confirms each queued or handled input. With a regular `pi`
process, send browser input while idle and queue busy input from the terminal. Both keep
terminal queues outside Inspire's Pending.

Run shell and slash commands and answer native dialogs in the terminal. Browser Stop requests
agent interruption. When Pi cannot confirm admission or a reply is lost, Inspire keeps the
draft and checks the original receipt on retry. An input still in Pi's hooks can leave Stop
unconfirmed.

A read-only view stays on its branch. Use **Switch branch…** in the title menu to choose another,
or **Copy resume command** in the palette to open the session in a terminal. If the attached Pi
exits, switches sessions or branches, or stops answering beyond the reload window, Inspire reports
what it observed. The Host continues the same view with its own Pi when that branch is free.
An interrupted task with no confirmed outcome is shown as unknown. A terminal Pi without
attach-control can still append to the session independently.

**Protocol.** Each live session context writes a record (session ID and file, current branch
leaf, activity, model, process identity, endpoint and token) to `pi-attach-control` under
`$XDG_RUNTIME_DIR` (else `~/.cache`), `~/Library/Caches` on macOS or `%LOCALAPPDATA%` on Windows.
The endpoint is a private local socket (a named pipe on Windows). A client sends one JSON line,
`{"token": …, "op": …}`, and reads one reply. Operations are `state`, `prompt`, `abort`,
`rename`, `models`, `set_model`, `set_thinking` and `shutdown`. Requests can include `sessionFile` and
`expectedLeafId`; input and Stop reject a changed session or a live position outside the expected
branch. Session deletion uses `shutdown` across all discovered branches, then waits for exit.
`PI_ATTACH_CONTROL=0` disables the extension for one process. `PI_ATTACH_CONTROL_TAG` adds a
client label to the record. Inspire uses worker tags to distinguish its own workers from other Pi
processes.

## Try the native UI example

The small [native UI extension](examples/native-ui.ts) uses the same portable primitives in Pi's
terminal and Inspire. From a checkout, try it without other extensions or a saved session:

```sh
pi --offline --no-session --no-extensions --extension ./docs/examples/native-ui.ts
```

Run these commands in the interactive terminal, or in Inspire after loading the file through Pi's
normal extension configuration and reloading an idle session:

- `/ui-demo` — select a review topic, confirm it, enter a name, and edit multiline notes. The result
  updates a status, places text widgets above and below Composer, and adds a readable custom message.
- `/ui-demo timeout` — try a ten-second input request.
- `/ui-demo clear` — remove the demo status and widgets. The recorded custom message stays in history.

The demo requires no model credentials. Use stable keys to replace or clear status and widgets;
the browser displays the supplied text.

## Text-widget recipes

### Todo widget

Keep one Todo model and provide a renderer for each mode:

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Todo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

function updateTodoPresentation(ctx: ExtensionContext, todos: Todo[]) {
  const visible = todos.filter((todo) => todo.status !== "completed");
  if (visible.length === 0) {
    ctx.ui.setWidget("example.todos", undefined);
    return;
  }

  if (ctx.mode === "rpc") {
    ctx.ui.setWidget(
      "example.todos",
      visible.map((todo) =>
        `${todo.status === "in_progress" ? "→" : "·"} ${todo.content}`,
      ),
      { placement: "aboveEditor" },
    );
    return;
  }

  // Your extension's existing TUI component factory.
  ctx.ui.setWidget("example.todos", createTodoComponent(visible), {
    placement: "aboveEditor",
  });
}
```

Use a stable namespaced key and clear the widget when its state expires. Keys longer than 240 characters are rejected. Send plain text in RPC mode; Inspire strips terminal control sequences.

### Usage footer

A TUI footer factory cannot cross RPC. Use `setStatus` for the compact fact and a command-toggled widget for detail:

```ts
function publishUsage(ctx: ExtensionContext, usage: Usage) {
  ctx.ui.setStatus(
    "example.usage",
    `5h ${usage.fiveHourPercent}% · week ${usage.weekPercent}%`,
  );

  if (ctx.mode === "rpc") {
    ctx.ui.setWidget(
      "example.usage-details",
      usageDetailsOpen
        ? [
            `5 hour window   ${usage.fiveHourPercent}%`,
            `Weekly window   ${usage.weekPercent}%`,
            `Resets          ${usage.resetLabel}`,
          ]
        : undefined,
      { placement: "belowEditor" },
    );
  }
}
```

Register `/usage` to toggle `usageDetailsOpen`. Fetching, caching, and calculations stay in the extension.

## Permission and question recipes

Inspire renders Pi's standard dialogs with keyboard, pointer and touch support, so these need no
Inspire changes. Keep the policy in your extension.

### Permission prompt

Block a tool call until the user decides, remembering "always" for the session:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const allowed = new Set<string>();
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || allowed.has("bash")) return;
    if (!ctx.hasUI) return { block: true, reason: "No UI to ask for permission" };
    const choice = await ctx.ui.select(
      `Run: ${event.input.command}`,
      ["Allow once", "Always allow bash this session", "Deny"],
      { timeout: 60_000 },
    );
    if (choice === "Always allow bash this session") allowed.add("bash");
    else if (choice !== "Allow once")
      return { block: true, reason: "Denied by the user" };
  });
}
```

A timeout or dismissal returns `undefined`, which this example treats as Deny. Stop sends
`cancelled` to pending dialogs, so the same branch handles it.

For a sequence of questions, the [native UI example](examples/native-ui.ts) collects a choice,
confirmation, name and notes. It stops when the user cancels and publishes the completed review
in text widgets.

## Custom cards and source changes

A [tool-presentation rule](tool-presentations.md#example) maps an exact tool name to a summary and typed blocks. It can also replace a native-name mapping when an extension overrides that tool. Rules customize content within the existing card; they cannot inject React, HTML, CSS, or JavaScript.

For interactions that need a dedicated control, modify the relevant source owner:

| Surface | Source |
| --- | --- |
| Command discovery | `src/components/CommandPalette.tsx` — registered Pi commands already appear here. |
| Frequent session-wide action | `src/components/AppTopbar.tsx` |
| Composer-adjacent RPC widgets | `src/components/ExtensionDisplays.tsx` |
| Unknown one-way display messages | `src/components/transcript-rows.tsx` |
| Project/session detail | `src/components/ContextPane.tsx` and its Files, preview, and Changes children |
| State and event projection | `src/store.ts`, `src/events.ts` |
| Layout composition | `src/App.tsx` |
| Dialog focus | `src/use-modal-focus.ts` |
| Styling | Tokens in `src/styles/foundation.css` and the relevant `src/styles/*.css` component sheet |

A pinned command button should use `store.sendPreparedCommand("/goal")`, which dispatches independently of the Composer's draft, attachments, and project-file references. Disable the button when the command is absent. Put occasional or argument-taking actions in the palette/Composer instead of adding permanent controls.

### Reusable components in a source checkout

Use these components with Inspire's styles or bring your own view. Keep extension state and
permission decisions in Pi. An adapter checks the current session, view, and command inventory
before dispatching an action. Pass the result and callbacks into the view.

| Component | Interaction and props |
| --- | --- |
| [Modal, DialogHeader, ConfirmationDialog](../src/components/Modal.tsx) | Name the modal with `aria-label` or `aria-labelledby`. `Modal` manages initial focus, Tab and focus restoration. Pass `onDismiss` for Escape and backdrop dismissal, or `onEscape` for Escape alone. Use `ConfirmationDialog` for a browser-side confirmation with a description, action and busy/error state. |
| [ExtensionDialogContent](../src/components/ExtensionDialogContent.tsx) | Pass a `question` with a title and a `method` of `select`, `confirm`, `input` or `editor`. `onAnswer` receives a string from selection/text or a boolean from confirmation. `onCancel` is a separate action. `pending` disables responses and `error` displays a failed response. Provide a new React key for a new question. |
| [PromptInput, PromptChoices](../src/components/PromptFields.tsx) | Use one field or choice list inline or in a modal. `PromptInput` accepts `initialValue` for its own draft, or `value` and `onValueChange` for a controlled draft. `PromptChoices` accepts labelled options and reports the selected value through `onChoose`. |
| [Dropdown](../src/components/Dropdown.tsx) | Pass an accessible label, current value, labelled options, and an `onChange` callback. Options can include descriptions. |
| [ToggleSwitch](../src/components/ToggleSwitch.tsx) | Pass the controlled `checked` value and `onChange` callback. Use `busy` while submitting to keep focus on the switch and prevent a second activation. |
| [EmptyState](../src/components/EmptyState.tsx) | Give the state a short `title`, an optional `hint` and an action as a child when available. Use `role="status"` for changing state or `role="alert"` for an error that needs attention. |
| [DetailSummary](../src/components/DetailSummary.tsx), [CodeView](../src/components/CodeView.tsx) | Use `DetailSummary` as the first child of a native `<details>`. `CodeView` displays text and accepts an optional syntax language. |

For a local choice, compose the question body with the modal. Mount this component when a
question opens. The parent handles the answer and closes the dialog.

```tsx
import { ExtensionDialogContent } from "./src/components/ExtensionDialogContent";
import { Modal } from "./src/components/Modal";

function ReviewFormat({
  onChoose,
  onClose,
}: {
  onChoose: (value: string) => void;
  onClose: () => void;
}) {
  const title = "Choose a review format";
  return (
    <Modal aria-label={title} onDismiss={onClose}>
      <div className="dialog">
        <ExtensionDialogContent
          question={{ method: "select", title, options: ["Summary", "Full report"] }}
          pending={false}
          onAnswer={(answer) => {
            if (typeof answer === "string") onChoose(answer);
          }}
          onCancel={onClose}
        />
      </div>
    </Modal>
  );
}
```

For an extension permission prompt, ask with Pi's native `ctx.ui.confirm`. Inspire's
`ExtensionUiDialog` connects native questions to this presentation and owns the request identity,
transport and deadline. The [task-board example](examples/task-board/README.md) shows the full
extension, adapter and view, including how to reuse `EmptyState` in a custom panel.

Keep runtime widgets near Composer, tool results in their cards, and project details in Files and
Changes. Use Settings for persisted preferences. Follow neighboring controls' accessible labels,
keyboard behavior and pointer/touch target sizes.

## Reload and verify

| Changed content | Apply it |
| --- | --- |
| Pi extension, skill, prompt, or context file | Run `/reload` in an idle Inspire-owned session to replace its worker and reset its in-memory extension state. For a connected external Pi, reload in its terminal. |
| Selected tool-presentation JSON | Save and refresh the browser; authenticated bootstrap revalidates it. |
| Host environment or configuration-file path | Restart the Host. |
| React, CSS, or contract source | Rebuild. In a checkout, `npm run inspire -- restart` detects changed browser inputs and rebuilds before restarting. |

Verify the adaptation's update/clear/failure paths, switching between sessions, and reconnect. Check both RPC and retained TUI behavior, plus long content, keyboard focus, light/dark themes, and a narrow viewport. Use synthetic data in committed fixtures and screenshots.
