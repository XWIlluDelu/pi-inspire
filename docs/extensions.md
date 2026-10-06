# Adapting Pi extensions to Inspire

Pi loads your extensions and owns their tools, commands, state, and lifecycle. Inspire presents their RPC-visible data in the browser. Start with commands, dialogs, and text widgets; use [tool-presentation rules](tool-presentations.md) for custom cards. Dedicated buttons, panels, and shortcuts currently require source changes.

Inspire ships native cards for `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, and `ls`. Other tools get generic cards with arguments, output, images, and expandable structured details. Inspire also loads an internal GUI bridge for branch navigation, model-catalog refresh, effective retry settings, and authentication; it adds no model tools.

The Host uses your installed Pi for both SDK calls and RPC workers. `package.json` pins the development test version, not the runtime installation.

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

Dialog timeouts dismiss the browser request, as do Inspire's Stop and worker cleanup. An extension's
own `AbortSignal` resolves the dialog in Pi 1.0 without sending a browser-dismissal event, so that
request can remain visible until answered or cleared by Inspire.

## Startup

RPC startup must finish before Pi can consume a dialog response. Awaiting `select`, `confirm`, `input`, or `editor` in `session_start` therefore fails with `PI_STARTUP_RESPONSE_UI_UNSUPPORTED`, and Inspire stops that worker. Startup notices, status, and text widgets work.

For interactive setup, register a command and advertise it in a startup notice or widget. The command can open dialogs once the worker is ready. Retain the existing interactive startup path in TUI mode if needed.

Extension factories also run during prospective-workspace model discovery, without `session_start`
or a persistent session. Register capabilities there; start processes, watchers and timers from
`session_start` or the command/tool that needs them, and release them in an idempotent
`session_shutdown` handler.

## Session lifecycle

GUI navigation uses independent workers rather than switching one TUI process between every conversation:

| GUI action | Extension lifecycle |
| --- | --- |
| Select a conversation | Changes the browser view. A cached worker keeps running; selection does not call its `session_before_switch` or rerun `session_start`. Starting or restoring a worker runs normal startup. |
| New session | Starts an independent worker. |
| Navigate within a session tree | Uses Pi's `navigateTree` operation and native hooks through the internal command bridge. |
| Fork / Clone | Copies a verified snapshot through Pi's `SessionManager` into a separate session. Fork excludes the selected input; Clone includes its endpoint. Source `session_before_fork` / `session_fork` hooks do not run and cannot veto either copy. Persisted extension entries follow Pi branch semantics; process memory and pending dialogs stay with the source. The destination loads extensions during startup. |

Keep state scoped to its Pi session and reconstruct it from persisted entries during `session_start` where appropriate. An extension relying on source-runtime switch/fork hooks needs to account for these GUI actions separately.

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

A pinned command button should reuse command dispatch, for example `store.sendPrompt("/goal")`, and be disabled when that command is absent. Put occasional or argument-taking actions in the palette/Composer instead of adding permanent controls.

Reuse existing icons, tokens, modal focus, and responsive drawers. Keep runtime widgets near the Composer, tool results in their cards, and project details in Resources. Settings is for persisted preferences. Match neighboring controls' accessible labels and keyboard behavior, retain 44px coarse-pointer targets, and respect reduced motion.

Inspire has no runtime React plugin API. Source customization needs a checkout and a rebuilt frontend; the npm package contains the built application.

## Reload and verify

| Changed content | Apply it |
| --- | --- |
| Pi extension, skill, prompt, or context file | Run `/reload` in the idle session. It replaces that worker and resets its in-memory extension state. |
| Selected tool-presentation JSON | Save and refresh the browser; authenticated bootstrap revalidates it. |
| Host environment or configuration-file path | Restart the Host. |
| React, CSS, or contract source | Rebuild. In a checkout, `./inspire restart` detects changed browser inputs and rebuilds before restarting. |

Verify the adaptation's update/clear/failure paths, switching between sessions, and reconnect. Check both RPC and retained TUI behavior, plus long content, keyboard focus, light/dark themes, and a narrow viewport. Use synthetic data in committed fixtures and screenshots.
