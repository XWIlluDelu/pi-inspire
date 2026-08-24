# Adapting Pi Extensions to INSΠRE

INSΠRE is an extension-neutral Web frontend for Pi. Pi remains the authority for an Extension's commands, tools, state, and lifecycle; INSΠRE projects the parts of Pi's RPC protocol that have Web meaning. It does not recognize third-party Extension package names or translate terminal components into React.

The only Extension shipped by INSΠRE is a private branch-operation bridge used by the Host. It has no user-facing presentation. The rich cards shipped for `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` describe Pi-native tool shapes, not particular third-party Extensions.

This guide is for light adaptation: keep the Extension as the behavioral owner, use existing generic projections where possible, and make a small source change only when a dedicated GUI surface is genuinely better. Replacing the whole workbench is outside this guide.

## What works without an INSΠRE patch

The supported Pi version is the one pinned by this project. Its RPC behavior is the compatibility authority.

| Pi Extension feature | INSΠRE behavior | Adaptation advice |
| --- | --- | --- |
| `registerCommand()` | Commands appear in the command palette and Composer `/` completion. | Prefer this for occasional actions. No dedicated button is normally needed. |
| `registerTool()` | The tool runs in Pi. Unknown tools receive a complete generic card. | Add a data-only Tool Presentation when the arguments or result have a stable useful shape. |
| `select`, `confirm`, `input`, `editor` | Native INSΠRE modal dialog. | Use for interactions that must block the Extension until the user answers. |
| `notify` | Transient notice. | Use for a completed event, warning, or failure—not durable state. |
| `setStatus` | Compact text in the desktop top bar; long values are visually truncated with the full value in the tooltip. Current keyed values survive a browser reconnect and clear with the owning worker. | Keep it short and clear it with the same key. Mobile intentionally omits Extension status text. |
| `setWidget(key, string[], placement)` | Native bounded text widget immediately above or below the Composer. Updates replace the same key; `undefined` clears it. | Best generic surface for Todo lists, quotas, and session state that informs the next prompt. |
| `setWidget(key, componentFactory)` | Ignored by Pi in RPC mode. | Supply a string-array branch when `ctx.mode === "rpc"`; retain the factory for TUI mode. |
| `setTitle` | Browser document title. | Treat it as transient session presentation. |
| `setEditorText` | Replaces the current Composer draft through Pi's RPC request. | Use sparingly; never assume ownership of a draft after the user edits it. |
| `custom()` | Returns `undefined` in RPC mode. | Replace it with the standard dialogs or a command-driven Web path. |
| `setFooter`, `setHeader`, `setEditorComponent`, `setWorkingMessage`, `setWorkingIndicator`, `setToolsExpanded` | Pi RPC makes these no-ops or fixed defaults. | Do not infer a Web placement from a terminal layout. Choose a semantic Web surface below. |
| TUI message/tool renderers and component factories | Not serialized by Pi RPC. | Keep them as TUI presentation; INSΠRE uses its native or generic Web renderer. |
| `registerShortcut()` and raw terminal input | No browser shortcut contribution is created. | Register a command first. Add a Web shortcut only in a source customization with conflict and focus handling. |

Component factories are the most common source of a misleading result: the Extension is running, but there is nothing Pi can send to the browser. Branch on `ctx.mode`, not `ctx.hasUI`; both TUI and RPC report UI availability.

## Choose the smallest adapter

Use this order. Stop at the first level that expresses the behavior honestly.

1. **Existing RPC projection** — commands, dialogs, notices, status, and text widgets require no INSΠRE change.
2. **Tool Presentation configuration** — describe a custom or overridden Tool with INSΠRE's bounded data-only rule format.
3. **Small source adaptation** — add a dedicated button or panel only when the interaction is frequent and its data cannot be represented by the first two levels.
4. **New shared protocol** — propose this only when several real Extensions need the same missing semantics. A private event convention or arbitrary browser code injection is not a substitute for a protocol.

INSΠRE has no runtime React plugin API. Source-level UI adaptations require a source checkout and carry their own merge responsibility. The installed npm package contains the built application, not an editable frontend SDK.

## Place UI by meaning

Do not group unrelated features merely because they came from Extensions.

| Information or action | Preferred surface | Avoid |
| --- | --- | --- |
| Occasional action | Existing Pi command in the command palette | Permanent top-bar button |
| Frequent session-wide action | One quiet icon button in `AppTopbar` | Text button competing with session identity |
| State relevant to the next prompt | `setWidget(..., { placement: "aboveEditor" })` | A transcript message repeated on every update |
| Secondary status or quota detail | Short `setStatus`; command-toggled text widget for detail | Replacing INSΠRE's run-state chip or footer |
| Tool invocation and result | Tool card / Tool Presentation | Separate global panel duplicating the result |
| Project files, changes, or branch-shaped data | A Resources-pane mode | Squeezing a large panel beside the Composer |
| Blocking choice | Existing Extension dialog methods | Hand-built overlay or `window.confirm()` |
| Transient completion or warning | `notify` | Persistent widget |
| Durable conversational fact | Pi message or Extension-owned persistence | Browser `localStorage` as a second authority |

Settings is for persisted INSΠRE preferences. Runtime diagnostics, Todo state, and quotas do not belong there merely because space is available.

## Recipe: preserve a TUI Todo widget and add the Web projection

Keep the Todo model and mutations in the Extension. Only the rendering branch changes:

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Todo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

function todoLines(todos: Todo[]): string[] {
  return todos.map((todo) => {
    const mark =
      todo.status === "completed"
        ? "✓"
        : todo.status === "in_progress"
          ? "→"
          : "·";
    return `${mark} ${todo.content}`;
  });
}

function updateTodoPresentation(ctx: ExtensionContext, todos: Todo[]) {
  const visible = todos.filter((todo) => todo.status !== "completed");
  if (visible.length === 0) {
    ctx.ui.setWidget("example.todos", undefined);
    return;
  }

  if (ctx.mode === "rpc") {
    ctx.ui.setWidget("example.todos", todoLines(visible), {
      placement: "aboveEditor",
    });
    return;
  }

  // Keep the Extension's existing TUI component factory here.
  ctx.ui.setWidget("example.todos", createTodoComponent(visible), {
    placement: "aboveEditor",
  });
}
```

Use one stable, namespaced key; every update replaces that widget. Clear it when empty and during the Extension lifecycle that invalidates its state. Send plain semantic text in RPC mode. INSΠRE strips terminal control sequences rather than reproducing ANSI styling.

Do not parse the TUI component's rendered lines back into a Todo model. Both renderers must read the same Extension-owned state.

## Recipe: adapt a quota or usage footer

A TUI footer factory cannot cross RPC. Split the compact fact from optional detail:

```ts
function publishUsage(ctx: ExtensionContext, usage: Usage) {
  ctx.ui.setStatus(
    "example.usage",
    `5h ${usage.fiveHourPercent}% · week ${usage.weekPercent}%`,
  );

  if (ctx.mode === "rpc" && usageDetailsOpen) {
    ctx.ui.setWidget(
      "example.usage-details",
      [
        `5 hour window   ${usage.fiveHourPercent}%`,
        `Weekly window   ${usage.weekPercent}%`,
        `Resets          ${usage.resetLabel}`,
      ],
      { placement: "belowEditor" },
    );
  } else if (ctx.mode === "rpc") {
    ctx.ui.setWidget("example.usage-details", undefined);
  }
}
```

Register a `/usage` command to toggle `usageDetailsOpen`; it is automatically discoverable in INSΠRE. Keep the status short, and keep fetching, caching, and reset calculations in the Extension.

## Recipe: present a custom or overridden Tool

Use the ignored local configuration described in [Custom tool presentations](tool-presentations.md). The minimum useful configuration maps an exact RPC tool name to a namespaced rule:

```json
{
  "version": 1,
  "rules": {
    "user.example.search": {
      "summary": [
        { "value": { "path": "args.query", "prefix": "/", "suffix": "/" } }
      ],
      "blocks": [
        {
          "type": "search",
          "label": "Matches",
          "source": { "path": "result.text" },
          "format": "grouped-lines"
        }
      ]
    }
  },
  "mappings": {
    "my_search": "user.example.search"
  }
}
```

The rule owns summary content and typed blocks. INSΠRE owns card layout, typography, disclosure, truncation, resource behavior, accessibility, and responsive presentation. Rules cannot inject React, HTML, CSS, JavaScript, filesystem reads, or network requests. A missing or incompatible value falls back to the generic raw card rather than inventing output.

## Source-level adaptation

First confirm that an existing command or widget is insufficient. Then modify the narrowest current owner:

- `src/components/CommandPalette.tsx` — discoverable actions. Pi commands already enter automatically.
- `src/components/AppTopbar.tsx` — only frequent session-wide navigation or actions.
- `src/components/ExtensionDisplays.tsx` — generic RPC text-widget presentation beside the Composer.
- `src/components/transcript-rows.tsx` — inspectable fallback for unknown one-way display methods.
- `src/components/ResourcesPane.tsx` — persistent project/session detail with its own navigation mode.
- `src/App.tsx` — composition and placement, not feature state.
- `src/store.ts` and `src/events.ts` — browser projection and lifecycle; do not put product state in components.
- `shared/contracts.ts` and `server/runtime.ts` — only when the Host must validate or project new data.
- `src/use-modal-focus.ts` — the sole modal ownership mechanism.
- `src/styles.css` — existing tokens and component classes remain the visual authority.

A justified pinned command button should reuse the same execution path as the command palette:

```tsx
<button
  type="button"
  className="icon-button"
  aria-label="Open goals"
  title="Open goals"
  disabled={!state.commands.some((command) => command.name === "goal")}
  onClick={() => void store.sendPrompt("/goal")}
>
  <Target size={15} aria-hidden />
</button>
```

Place it in `topbar__actions` only if the action is frequent enough to justify permanent chrome. Keep the registered Pi command as the fallback and source of behavior. Commands requiring free-form arguments should remain in the Composer rather than opening an ad hoc prompt.

### Reload boundaries

- Pi loads Extensions into each worker. An Extension source change is not a live frontend update; a fresh Host restart is the definitive reload after active work has settled.
- Tool Presentation configuration is revalidated on authenticated bootstrap/refresh and does not require rebuilding INSΠRE.
- React, contract, or CSS changes require a source build. In a source checkout, the launcher detects changed browser-build inputs; `./inspire restart` rebuilds when needed and then starts fresh workers. An installed npm package does not contain the TypeScript source to patch.

## Visual and interaction rules

A source adaptation should look like INSΠRE, not like a mini-application mounted inside it.

- Reuse CSS variables and existing classes; do not add raw theme colors or duplicate light/dark branches.
- Use Lucide icons at the neighboring control's size and stroke. An icon-only control needs both `aria-label` and `title`.
- Use accent for selection/action, violet for Thinking, cyan for tool activity, and semantic warning/error/success colors only for those states.
- Keep top-bar actions quiet and icon-only. Keep long text in a bounded panel or widget, not navigation chrome.
- Preserve the current reading width. A new wide data view belongs in Resources rather than widening Transcript.
- At the narrow-workbench boundary, use the existing drawer/overlay model; do not squeeze side panels into the center. Touch targets must remain at least 44 by 44 CSS pixels where coarse-pointer controls are exposed.
- Reuse `useModalFocus` for dialogs. Only the top modal handles Escape and Tab; shell shortcuts must not fire through it.
- Respect reduced motion and existing duration/easing tokens. Add motion only to explain state or spatial change.
- Keep extension state session-scoped when Pi scopes it to a session. Clear or replace stale projections on session and worker lifecycle boundaries.

## Verification checklist

For a light adaptation, verify only the states its semantics require:

- Extension absent, loading, active, updated, cleared, and failed where applicable.
- TUI mode still uses the original presentation; RPC mode emits only serializable data.
- Switching sessions does not show another session's widget or status.
- Reconnect or worker replacement does not leave stale browser-only authority.
- The command remains usable from the command palette when a dedicated control is absent.
- Long text is bounded; complete Tool arguments/results remain available through the ordinary card copy behavior.
- Keyboard focus, Escape, screen-reader labels, dark/light themes, and a 390-pixel viewport remain usable.
- No credential or private payload is copied into frontend configuration, fixtures, screenshots, or committed documentation.

If several adaptations repeatedly require the same missing capability, document the common semantics before adding a shared contribution point. The next step should be a bounded, versioned, data-oriented contract—not arbitrary executable frontend injection.
