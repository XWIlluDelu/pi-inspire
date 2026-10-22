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
own `AbortSignal` resolves the dialog in Pi 1.0/1.1 without sending a browser-dismissal event, so that
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

GUI navigation uses independent workers rather than switching one TUI process between every conversation:

| GUI action | Extension lifecycle |
| --- | --- |
| Select a conversation | Changes the browser view. A cached worker keeps running; selection does not call its `session_before_switch` or rerun `session_start`. Starting or restoring a worker runs normal startup. |
| New session | Starts an independent worker. |
| Navigate within a session tree | Uses Pi's `navigateTree` operation and native hooks through the internal command bridge. |
| Fork / Clone | Copies a verified snapshot through Pi's `SessionManager` into a separate session. Fork excludes the selected input; Clone includes its endpoint. Source `session_before_fork` / `session_fork` hooks do not run and cannot veto either copy. Persisted extension entries follow Pi branch semantics; process memory and pending dialogs stay with the source. The destination loads extensions during startup. |

Keep state scoped to its Pi session and reconstruct it from persisted entries during `session_start` where appropriate. An extension relying on source-runtime switch/fork hooks needs to account for these GUI actions separately.

## Show external session activity

The optional [session activity extension](examples/session-activity.ts) lets Inspire show busy,
waiting-for-input and idle state for local external Pi sessions, including independent RPC hosts
and terminal, JSON or print modes. Herdr and external execution connectors are not required:
observing activity alone does not attach a controller or grant execution authority. The same extension
reports process-bound session presence so Inspire can open an already-held session read-only
instead of starting a second writer, even when the other Pi is idle.

Enable the extension once through Pi's normal user configuration. From an Inspire checkout:

```sh
pi install /absolute/path/to/inspire/docs/examples/session-activity.ts
```

The same file ships in the installed Inspire package. Use its absolute path there, or copy it into
your Pi user extensions directory. New Pi sessions load it automatically. In an existing terminal
session, run `/reload` when idle to activate it. An existing RPC session needs its original host's
supported reload or a later normal restart; restarting Inspire does not reload an external Pi.
Remove the configured file with `pi remove` (or remove your copied extension) and reload to disable
reporting.

Reporting adds no tools, model prompts or session entries and makes no network requests. It writes
small, private records into the local user's Inspire cache. Busy indicators expire after
about eight seconds without a heartbeat. Session presence does not: idle, a stalled heartbeat
or a missing previously observed report is not proof of release, including across Host restart.
Inspire retains that positive admission evidence privately. Shutdown stops activity observation,
not writer protection: other shutdown callbacks can still write. Native new/resume/fork releases
the outgoing file only after the replacement starts and uniquely matches the old and new files.
Reload preserves presence; same-file replacement stays protected. Quit, failed/ambiguous replacement,
and SDK disposal without a completed native rebind remain protected until process exit is verified.

A long-lived SDK host disposing just one session has no reporter-visible post-disposal write-drain
signal, so that file can remain read-only while the process lives. Older reporters' `released`
markers are also activity hints, not proof of release; legacy teardown records may therefore
remain protected until their Pi process normally exits. Do not delete the cache to bypass this.

Only persisted sessions discoverable in Inspire's configured Pi storage can appear; reporting
does not change those storage roots. Sessions that explicitly disable extensions do not report. Inspire-managed RPC workers
continue to use their existing runtime status: the reporter recognizes the loaded internal GUI bridge,
not RPC mode or inherited environment alone. Each session counts once in the titlebar animation.

To activate an updated implementation, update/restart the Inspire Host **and** reload or normally
restart each external Pi through its own host. They load code independently. An external Pi that
never loaded the reporter has no presence record to inspect; the extension does not discover
arbitrary uninstrumented processes or take control of them. Do not clear the cache to bypass a
live-holder warning. Once the other Pi releases the session, reselect it in Inspire to retry.

### Control the same Herdr Pi terminal

In a Herdr TUI, this same extension also handles Inspire input, Steer, Follow-up, agent Stop and rename
through Pi's public functions. No additional extension is needed. It reuses Herdr's existing terminal
control permission, not your shortcut bindings or screen layout; it adds no service listener or
credentials. Temporary action payloads use the same private cache. Presence reports by themselves
are not a control channel, and an ordinary Pi outside Herdr remains observation-only.

Reload the updated file with `/reload` in the original idle Pi terminal, or start Pi normally next time.
Inspire connects to that process; returning to the original terminal continues the same instance.
An unsent terminal draft or unanswered dialog prevents new browser input without altering either.
A call receipt means Pi's public function returned, not that a message ran or work completed;
extensions can handle input without a model turn, and native asynchronous errors remain in Pi.

Shell `!`/`!!` and interactive built-ins must run in the original terminal or their existing Inspire
command surface, not as model prompts. Extension commands and prompt templates still use native
dispatch. Agent Stop requests `ctx.abort()`, including Pi's native queued-message restoration. It
does **not** cancel a shell started in the terminal; interrupt that shell in the original terminal.

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

## Choose the smallest integration

There are three distinct levels:

1. **Native RPC, no frontend changes:** commands, standard dialogs, notices, status and text widgets.
2. **Declarative presentation:** map stable tool/custom-message data to existing typed blocks and
   nested properties. These are display rules, not a general subagent manager.
3. **Source DIY:** add purpose-built React controls and a small adapter in a checkout. Pi extensions
   still own state and behavior; Inspire does not supply a scheduler or permission policy.

The complete [source task-board example](examples/task-board/README.md) includes the Pi extension,
shared data/actions, props-only list/detail UI, adapter, styles, mounting instructions, build/reload
steps and session-cleanup checks. It uses cancellable demonstration timers rather than launching
agents. Its Stop/Retry/Open notes actions require both extension-declared capability and the current
loaded command inventory, and prepared commands preserve the browser's draft and attachments.

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

Reuse existing icons, tokens, modal focus, and responsive drawers. Keep runtime widgets near the Composer, tool results in their cards, and project details in Resources. Settings is for persisted preferences. Follow neighboring controls' accessible labels, keyboard behavior, and pointer/touch target sizes, and respect reduced motion.

Inspire has no runtime React plugin API. Source customization needs a checkout and a rebuilt frontend; the npm package contains the built application.

## Reload and verify

| Changed content | Apply it |
| --- | --- |
| Pi extension, skill, prompt, or context file | Run `/reload` in an idle Inspire-owned session to replace its worker and reset its in-memory extension state. For a connected external Pi, reload in its terminal. |
| Selected tool-presentation JSON | Save and refresh the browser; authenticated bootstrap revalidates it. |
| Host environment or configuration-file path | Restart the Host. |
| React, CSS, or contract source | Rebuild. In a checkout, `./inspire restart` detects changed browser inputs and rebuilds before restarting. |

Verify the adaptation's update/clear/failure paths, switching between sessions, and reconnect. Check both RPC and retained TUI behavior, plus long content, keyboard focus, light/dark themes, and a narrow viewport. Use synthetic data in committed fixtures and screenshots.
