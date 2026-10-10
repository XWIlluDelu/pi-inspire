# Pi commands in Inspire

Use the Composer's `/` completion or the optional command palette, opened from the topbar or with Ctrl/⌘+K at any screen width. Inspire combines Pi's extension, prompt, and skill commands with browser adaptations of Pi's built-ins. The palette opens with a compact set of actions and recent sessions; search reaches the full inventory, including terminal-only guidance. Aliases such as `/settings`, `/new`, `/resume`, `/tree`, and `/hotkeys` lead to the same graphical destinations rather than duplicate entries.

Graphical actions open their existing controls. Selecting an extension, template, or skill opens a temporary preparation step: review its arguments, then explicitly **Run command** or **Send prepared prompt**. Your message draft and attachments remain untouched. Extension handlers run immediately, including while Pi is busy; only templates and skills use the visible **Steer / Queue** choice during active work. Escape returns to palette search, then closes the palette. **Find a session** focuses the same full Host catalog search as `/resume`, including from the start surface; recent palette shortcuts remain direct jumps. It is not limited to already-loaded palette results.

| Commands | Browser behavior |
| --- | --- |
| `/model [provider/model]`, `/thinking [level]` | Open the picker, or set an exact model/level. |
| `/settings`, `/changelog` | Open settings or the installed Pi version's release notes. |
| `/scoped-models` | Open Settings → Models at the ordered common scope. |
| `/login [provider]`, `/logout [provider]` | Open native provider login or saved Host credential controls. |
| `/new`, `/resume` | Open the new-session surface or focus full catalog search in session navigation. |
| `/tree`, `/fork` | Open conversation History and its continuation/copy actions. |
| `/clone` | Open an independent copy of the current recorded conversation path, with an empty draft and no model turn. |
| `/name [name]` | Show or set the session name. |
| `/copy` | Copy the complete last settled assistant response. |
| `/compact [instructions]` | Compact the session through Pi. |
| `/export [path.html\|path.jsonl]` | Export native HTML by default, or the current branch as native-compatible JSONL when the path ends in `.jsonl`. |
| `/reload` | Restart the selected session's idle worker and reload Pi resources. |
| `/session`, `/hotkeys`, `/quit` | Show session information, browser shortcuts, or guidance for leaving the client. |
| `/share`, `/trust`, `/import`, `/bug` | Offer a copyable command and terminal guidance. |

Native commands take precedence over an extension, prompt, or skill with the same name, matching Pi's interactive client. Use namespaced extension commands to avoid collisions. Typed native commands reject staged attachments and project-file references; palette actions do not borrow those artifacts. Unknown slash commands are reported rather than sent to the model.

## History and independent copies

**History** in the contextual pane shows a compact outline led by your inputs. Expand replies and
activity when needed; **Other routes** appears at conversation branch points. Search reaches earlier
and alternate history, including complete retained text. Opening a point previews it in the same pane
without changing the current conversation or your draft; **Back to history** restores your search and
position. **Current conversation** returns to the active conversation's outline, not a context change.

- **Continue / Edit in this session** deliberately changes where Pi continues. Select **Carry branch
  summary** to include a summary of the conversation being left, with optional instructions.
  Inspire honors Pi's skip-summary-prompt setting. A draft-replacement confirmation appears only when
  an edit would replace an existing message draft. Text or attachments added while a summary is
  pending stay in your draft.
- **Fork into new session** copies the conversation before the selected input and prepares its text
  and saved images as an editable draft in the new session.
- **Clone into new session** copies through the selected response or other point and opens an empty
  draft. **Clone current branch** in the title's action menu, `/clone`, and the palette share this action;
  the earlier-conversation notice offers **Clone from here**.

Click the session title to open Rename, Clone and Export. Rename appears over the title, so another
click at the same point opens the editor. Fork and Clone leave the source task, Pending input and
saved draft intact. Neither sends a prompt.

## Models and thinking

Opening the model picker shows cached choices immediately, then refreshes available models in the
background without restarting Pi or interrupting its task and extension dialogs. Refresh keeps your
current model and thinking level. If discovery fails, the picker keeps cached choices and reports
that locally; `/reload` is not needed just to refresh model catalogs.

New sessions inherit the visible model and effort when available; otherwise Inspire reads Pi's
startup defaults for the chosen workspace. Switching the model on that surface uses Pi's configured
per-model/global thinking defaults and supported-level clamping. For example, `xhigh` or `max`
becomes `high` on a model supporting through `high`, rather than disabling thinking. You can still
choose another effort afterward. These are session choices, not writes to saved defaults.

Virtual models are marked **Router**. The picker and New inheritance retain your selected router;
reply headers and usage describe the physical model that answered. If a router is no longer
registered, reopened sessions follow Pi's physical-response recovery. Prospective-workspace discovery
includes global and already-trusted project extensions; untrusted project resources are skipped with
a warning. New trust decisions remain part of Pi startup.

## Model settings and login

**Manage models** in the picker opens Settings → Models. Save Pi's startup model and thinking defaults
there, separately from current-session choices. Project settings and per-model thinking preferences
retain native precedence. Saving a default does not switch an open session. **Not set** indicates no
specified startup model; **Clear** removes an existing default. **Model default** removes the saved
global thinking preference and leaves resolution to Pi. The footer's Reset preferences resets
Inspire's interface settings, not Pi model configuration or credentials.

Common models use Pi's `enabledModels` patterns and optional thinking suffixes. Add, remove and
reorder those entries in Settings; the picker shows their resolved choices first while keeping other
models searchable. With no common configuration there is no extra group or empty prompt.
**Next model**, **Previous model**, and **Cycle thinking level** are searchable palette actions:
`Alt+Shift+M`, `Alt+Shift+P`, and `Alt+Shift+R`. They use cached choices without a discovery wait and
work from a message draft. Open completions/menus, other editors, modals and IME retain shortcut
ownership; `/hotkeys` lists the same bindings.

Provider/model declaration controls edit Pi's native `models.json`, not an Inspire catalog. Common
fields are graphical; unedited metadata, headers, costs, compatibility overrides and other advanced
fields remain intact. Existing config symlinks are followed. Invalid files and external-change
conflicts are reported rather than overwritten. Removing a declaration neither removes a built-in
model nor logs out. Provider/model edits open a focused view with Save/Cancel always reachable;
Back or Cancel restores the list's search, position and focus. Configuration saves refresh availability
without replacing the active worker; a refresh warning does not mean that a committed file save failed.

Login saves credentials in Pi on the **connected Host**. **Connect provider** opens provider search;
**Manage** on a saved provider reveals its methods and credential removal. Choose a method, then
follow its link, code, selection or input in this browser. Only established
cross-device methods show **Remote login** and a circled-question explanation, available by keyboard
or tap. Other methods remain available without that label. Completion is reported only after Pi
accepts the result; existing keys and tokens are not displayed. **Remove saved credential** removes
Host storage only: it does not revoke provider-side access or remove environment/model-file sources.
Configuration remains usable independently of login availability.

## Runtime behavior settings

Settings → Behavior applies Pi delivery, automatic-compaction and retry changes to the selected
session's worker. Pi's setters also update global settings, subject to project overrides; other running
workers keep their own loaded values. Pi's acknowledgment confirms the applied value, not a successful
settings-file save. These controls are separate from Inspire's interface preferences.

## Direct shell input

Send `!command` to run a shell command through the selected Pi session and include its result in
subsequent model context. Use `!!command` to record and display the result without including it in
model context. Neither form starts a model reply. For example:

```sh
!pwd
!!git status --short
```

The shell card streams output and shows running, exit, cancelled, context, and truncation status.
Pi supplies the working directory, Bash extension hooks, recorded output, and any full-output path.
Results and their `!`/`!!` input history remain available after reopening. History shows/searches
these shell records; **View full output** opens a truncated result's complete saved log. This is not the independent
project terminal; shell input cannot carry attachments or project-file references.

Commands can run alongside a model task or compaction, with one native shell at a time. Ordinary
Send remains available while only the shell runs. **Stop** or Escape cancels that shell through Pi,
without recovering/dequeuing Pending input. When a model task or compaction also runs, it keeps first
ownership of Stop; use Stop again for a remaining shell. Open dialogs and completion menus retain
Escape ownership. A blocked extension Bash hook may require retiring only that session's worker;
an unconfirmed command outcome is reported rather than automatically retried.

## Files in a prompt

Choose an `@` completion to keep the file path in its sentence position; paths with spaces are quoted.
Repeated references remain inline. **Add project files** instead creates removable chips. On the
new-session surface, inline selections use absolute paths so a directory change cannot retarget them.

Sent ordinary uploads survive Host restart. Inspire keeps their copies while a retained session,
branch, fork, or recoverable Trash session references them, then reclaims unreferenced owned copies.
Deleting a session never removes original project files. Images remain embedded in Pi message data.

## Pending input and stopping

While Pi runs, select **Steer** to redirect its next turn or **Queue** to follow the current task.
Pending entries appear at the end of the conversation, with previews and Return, Copy and Clear
actions in the header. Activate their count in the activity bar to jump to and focus Pending without
moving focus into the editor. **Return all** removes all unconsumed input without stopping Pi:
Steer texts come first, then Queue texts, separated by blank lines and followed by your current draft. Edit this as one draft; sending uses the currently selected delivery mode.

When stopping a model task, **Stop** and Escape use the same recovery, so pending work does not restart the task.
An open modal, completion menu, or context-detail hint keeps first ownership of Escape. Pending's single/all copy actions
copy complete text, including messages not shown in the bounded preview. **Clear queue** asks for
confirmation before discarding pending input; it does not stop Pi or change your draft.

Return and Stop also restore original images submitted through Inspire, including images recalled
from history, as editable attachments beside your latest draft. Images already consumed by Pi do not
return. Files and project references that had not yet reached Pi return to the same draft. Explicit
Return focuses the editor unless you have moved to another control or opened a dialog.

Recovery restores your submitted images, not images added or replaced internally by extensions.
If Inspire cannot establish ownership of pending images, it reports that limitation rather than
restoring guessed copies. Ordinary text-only recovery is quiet.

## Argument assistance and help

After `/model `, completion offers Pi-provided `provider/model` candidates. After `/thinking `, it offers the active model's supported levels. Arrow keys, Enter, Tab, or a pointer insert the selected argument without submitting. Free-text built-ins such as `/name`, `/compact`, and `/export` show a concise usage hint. Existing inline `@` search remains available where a prompt needs a project path; export destinations are not suggested from existing project files. Inspire does not guess extension arguments because Pi's public command inventory does not expose completion callbacks.

`/hotkeys` opens browser-specific shortcuts, reflecting the current desktop send-key preference, touch-first Return behavior, completion, history, conversation search, and project-terminal modes. `/changelog` reads the matching release notes shipped with the installed Pi package; it does not open Settings or require a network lookup. Documentation links lead to current upstream documentation.

## Updates

Settings → System checks Pi, Inspire and Pi's globally installed extension packages.

## Export

Choose **Export** in the session-title menu, or **Export session** in the command palette. Both open
the same dialog: select **HTML** for the whole session or **JSONL** for the current branch, then
**Download**. JSONL preserves native entries, embedded images and extension metadata. Neither format
changes the source session.

Typed `/export [path]` remains available separately. It accepts one destination, including quoted
paths with spaces and `~/` paths; a `.jsonl` suffix selects JSONL, otherwise Pi exports HTML. Its
completion receipt offers **Download** and **Copy path**. Downloads preserve the generated snapshot,
even if the output file later changes. Re-export after a Host restart or an expired download link.

## Compaction and reload

`/compact` uses the same state-owned compaction indicator as automatic compaction and retains a completion receipt. Pi determines its duration; the Composer can retain Steer/Queue input meanwhile. **Stop** or Escape uses Pi's native cancellation and recovers unconsumed Pending input so it does not restart the task. Cooperative cancellation keeps the session's worker and extension state and shows a neutral cancelled receipt. An unresponsive extension hook may require retiring that worker and starting a fresh one on next use. A checkpoint already committed before Stop remains completed.

The small context ring shows occupancy, not compaction progress. Hover or focus it—or tap it on touch—to see the model and Pi's used tokens/context capacity. Tap outside to dismiss. When Pi temporarily reports unknown usage after compaction, the ring shows `—` while the hint retains known capacity and explains that the count updates after the next reply.

`/reload` is available when the selected Pi session is idle. It reloads extensions, skills, prompts, and context files by replacing that worker, resetting worker-local extension state. It does not restart the Host or other sessions. A Host restart reloads all workers and applies changed Host environment/configuration.

`/export` remains available during a run and captures the Pi content available at invocation, not a future completed answer.

## Sessions and terminal use

The History pane handles same-file navigation and independent Fork/Clone copies. Both copy actions leave the source session running and open a separate worker; extension authors should check the [lifecycle differences](extensions.md#session-lifecycle).

Keep one writer per Pi session. Stop the Host before continuing one of its sessions in a native Pi terminal; switching conversations alone does not release a cached worker. Project terminal tabs are separate shells, not attachments to the running Pi worker.

For extension commands, dialogs, and widgets, see [Extension adaptation](extensions.md).
