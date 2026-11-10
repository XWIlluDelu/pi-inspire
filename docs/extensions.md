# Adapting Pi extensions to Inspire

Pi loads your extensions and owns their tools, commands, state and lifecycle; Inspire shows their
RPC-visible data in the browser. Install extensions through Pi's normal configuration first:
presentation files and adapter toggles change only how Inspire displays them.

Inspire ships native cards for `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find` and
`ls`; other tools get generic cards with arguments, output, images and structured details. Inspire
also loads an internal GUI bridge (branch navigation, model-catalog refresh, retry settings and
authentication) that adds no model tools.

| I want to… | Use | Changes Inspire source? |
| --- | --- | --- |
| Ask the user a question or a permission | `ctx.ui.select` / `confirm` / `input` / `editor` ([recipes](#permission-and-question-recipes)) | No |
| Show a short live fact (usage, mode) | `ctx.ui.setStatus` ([usage footer](#usage-footer)) | No |
| Show a live list near the Composer | `ctx.ui.setWidget` ([Todo widget](#todo-widget)) | No |
| Offer an occasional action | `registerCommand` (palette and `/` completion) | No |
| Give a custom tool a readable card | [Tool-presentation rule](tool-presentations.md#example) | No (JSON) |
| Add a Fast/Standard-style toggle | [Status control](tool-presentations.md#extension-adapters) | No (JSON) |
| Add a dedicated panel or control | [Source DIY](#custom-cards-and-source-changes), e.g. the [task board](examples/task-board/README.md) | Yes |

Start with the [native UI example](#try-the-native-ui-example). To share sessions with terminal
Pi, install [attach-control](#share-sessions-with-terminal-pi). [Reload and verify](#reload-and-verify)
explains how to apply each kind of change.

## Choose the smallest integration

There are three levels:

1. **Native RPC, no frontend changes:** commands, standard dialogs, notices, status and text widgets.
2. **Declarative presentation:** map stable tool/custom-message data to existing typed blocks, or
   bind a discrete choice to an extension command and structured RPC status. See the
   [status-control contract](tool-presentations.md#extension-adapters). Use this before adding
   source-owned buttons; the extension retains state, persistence, and capability decisions.
3. **Source DIY:** add purpose-built React controls and a small adapter in a checkout. Pi extensions
   still own state and behavior; Inspire does not supply a scheduler or permission policy.

The [task-board example](examples/task-board/README.md) is a complete source integration: the Pi
extension, shared data and actions, a props-only list/detail UI, the adapter, styles, mounting and
reload steps, and cleanup checks. It runs demonstration timers instead of launching agents.

## What works through RPC

| Extension feature | Browser behavior | Adaptation |
| --- | --- | --- |
| `registerCommand()` | Command palette and Composer `/` completion. | Use for occasional actions. Native command names take precedence; namespaced commands avoid collisions. |
| `registerTool()` | Runs in Pi and receives a native, configured, or generic card. | Add a presentation rule for a useful stable data shape. |
| `select`, `confirm`, `input`, `editor` | Shared keyboard, pointer, and touch dialogs after worker startup. | Move interactive setup into a command; see [startup](#startup) and the [runnable example](#try-the-native-ui-example). |
| `notify` | Transient notice. | Use for completion, warning, or failure. |
| `setStatus` | Compact top-bar status at every screen width; click, tap or use the keyboard to read full status text. Retained up to 1,024 characters, restored on reconnect, cleared with the worker. | Keep the main fact short; full retained text remains readable on demand. |
| `setWidget(key, string[], options)` | Supplied text and Copy above or below Composer, without a key-derived heading. Reusing a key replaces it; `undefined` clears it. | Use for Todo lists, quotas, or next-prompt context. |
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

[attach-control](../extensions/attach-control.ts) is a generic Pi extension that lets a local
client attach to a live Pi and control it. Inspire uses it to show terminal Pi sessions and their
activity, and to continue them. It is a single file that ships with Inspire:

```sh
pi install /absolute/path/to/inspire/extensions/attach-control.ts
```

New Pi processes load it; run `/reload` in an idle terminal Pi to activate it there. Configurations
that point to the former `extensions/inspire-session-bridge.ts` or
`docs/examples/session-activity.ts` keep loading it.

With attach-control installed:

- A terminal Pi and Inspire can use the same session at the same time. There is no release or
  handoff step. Search for **Copy resume command** in the command palette to get the terminal
  command for the selected session.
- Opening a session that a live Pi is continuing on the branch you see shows it read-only, with its
  progress and **Take over**. If no live Pi shows that branch, Inspire continues it directly with
  its own Pi.
- **Take over** attaches to that Pi. The terminal keeps working, and both interfaces operate the
  same context and work: input, Steer/Follow-up, Stop, rename, model and thinking go to it. With
  several such Pi processes, Inspire prefers an idle one and keeps the resulting attachment.
- If the attached Pi exits, moves to another session or branch, or stops answering for longer than a
  reload takes, Inspire says which of these happened. It continues the same view with its own Pi
  once the branch is available.
  It does not claim a task failed: a Pi that moved or stopped answering may still be working, and
  a task interrupted by an exit is reported as ended with an unknown outcome.
- A read-only view follows the branch it opened on, even when another branch becomes the default.
  **Switch branch…** under **More actions** in the default title menu, or History, shows another
  branch by the same rule. Appends from other Pi processes are ordinary session use. A session you
  are working on in Inspire keeps its branch.

Limits of attaching to another Pi:

- Input queued in that Pi is not listed in Inspire's Pending; Pi has no public queue interface.
- Stop interrupts agent work. Run Pi slash commands and start or stop terminal shell commands
  from the attached Pi's own interface.
- A terminal Pi's native dialogs are answered there. Inspire-owned RPC workers preserved by
  `inspire restart --host-only` recover their pending questions in the browser after **Take over**.
  Select, confirm, input and editor answers continue through the original worker's RPC channel.
- A prompt receipt requires evidence that Pi started processing that input. If Pi queues or
  handles input without observable admission, or if the receipt is lost, Inspire retains the draft
  and checks the original receipt on retry. Stop requests agent interruption and reports an
  uncertain outcome while earlier input may still be in Pi's input hooks.
- A Pi without attach-control is invisible to Inspire; both can still append to the same session.

**Protocol.** Each live session context writes a record (session ID and file, current branch
leaf, activity, model, process identity, endpoint and token) to `pi-attach-control` under
`$XDG_RUNTIME_DIR` (else `~/.cache`), `~/Library/Caches` on macOS or `%LOCALAPPDATA%` on Windows.
The endpoint is a private local socket (a named pipe on Windows). A client sends one JSON line,
`{"token": …, "op": …}`, and reads one reply. Operations are `state`, `prompt`, `abort`,
`rename`, `models`, `set_model`, `set_thinking`, `shutdown` and
`ui_response` (for a retained RPC UI channel). Requests can include `sessionFile` and
`expectedLeafId`; input and Stop reject a changed session or a live position outside the expected
branch. Session deletion uses `shutdown` across all discovered branches, then waits for exit.
`PI_ATTACH_CONTROL=0` disables the extension for one process. `PI_ATTACH_CONTROL_TAG` adds a
client label to the record: Inspire loads attach-control into its own workers with their worker
tag, ignores those records while it owns the workers, and finds them again like any other Pi after
`inspire restart --host-only`.

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

The example makes no model request and requires no credentials. It also serves as the isolated native
integration fixture. Status and widget keys are update identities, not user-facing titles. Clear them
with `undefined`; use supplied text to communicate what matters. No terminal component factory is
needed here. For richer TUI components, retain a terminal branch and publish supported text/dialog
primitives for RPC rather than trying to serialize terminal rendering into the browser.

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

### Several questions

Pi's RPC dialogs ask one question at a time. Chain them, stop on the first `undefined`, and show
the collected answers in a widget so the user can see what was chosen:

```ts
const scope = await ctx.ui.select("Scope", ["Current file", "Whole project"]);
if (scope === undefined) return;
const depth = await ctx.ui.select("Depth", ["Quick", "Thorough"]);
if (depth === undefined) return;
ctx.ui.setWidget("example.review-plan", [`Scope: ${scope}`, `Depth: ${depth}`], {
  placement: "aboveEditor",
});
```

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

`src/components/ExtensionDialogContent.tsx` exports the existing standard dialog body without a
store or transport dependency. It accepts `request`, controlled `value`, `pending`, `error`,
`onValueChange`, `onRespond` and `onCancel`. `ExtensionUiDialog.tsx` keeps session/request ownership,
form state, communication, deadlines and modal focus. A source-owned dialog can reuse the body and
its normal styles; supply its own outer dialog/focus owner. Permission prompts should normally use
Pi's native `ctx.ui.confirm`, without introducing a persistent permission-list panel.

Reuse existing icons, tokens, modal focus, and responsive drawers. Keep runtime widgets near the Composer, tool results in their cards, and project details in Files and Changes. Settings is for persisted preferences. Follow neighboring controls' accessible labels, keyboard behavior, and pointer/touch target sizes, and respect reduced motion.

Inspire has no runtime React plugin API. Source customization needs a checkout and a rebuilt frontend; the npm package contains the built application.

## Reload and verify

| Changed content | Apply it |
| --- | --- |
| Pi extension, skill, prompt, or context file | Run `/reload` in an idle Inspire-owned session to replace its worker and reset its in-memory extension state. For a connected external Pi, reload in its terminal. |
| Selected tool-presentation JSON | Save and refresh the browser; authenticated bootstrap revalidates it. |
| Host environment or configuration-file path | Restart the Host. |
| React, CSS, or contract source | Rebuild. In a checkout, `npm run inspire -- restart` detects changed browser inputs and rebuilds before restarting. |

Verify the adaptation's update/clear/failure paths, switching between sessions, and reconnect. Check both RPC and retained TUI behavior, plus long content, keyboard focus, light/dark themes, and a narrow viewport. Use synthetic data in committed fixtures and screenshots.
