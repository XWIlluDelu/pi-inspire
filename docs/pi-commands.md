# Pi commands in Inspire

Open the command palette with the header button or Ctrl/⌘+K. Start typing to search actions,
sessions and Pi commands. Type `/` in the Composer for command completion. Pi built-ins reserve
their names ahead of extensions, templates and skills. An unknown command is reported in the
workbench. For setup, see [Your first session](../README.md#your-first-session).

The palette opens a preparation field for extensions, templates and skills. Review or edit the
arguments, then choose **Run** for an extension or **Send** for a prompt. While Pi works, prompts
offer **Steer Pi** and **Queue prompt**. Extension commands run immediately. Escape returns to
palette search. Palette actions preserve your draft and staged files. Remove attachments and
project-file chips before submitting a typed native command.

| Command | Action |
| --- | --- |
| `/model [provider/model]`, `/thinking [level]` | Open the picker or apply a specific choice. Completion offers available models and supported levels. |
| `/settings`, `/scoped-models` | Open Settings or the common model scope. |
| `/login [provider]`, `/logout [provider]` | Open Host provider login or saved credential controls. |
| `/new`, `/resume` | Open New session or focus search across the full Host session catalog. |
| `/tree`, `/fork`, `/clone` | Open History, show how to fork from a user message, or clone the current branch. |
| `/name [name]`, `/copy` | Show or change the session name, or copy the complete last settled assistant response. |
| `/compact [instructions]`, `/reload` | Compact the selected idle Inspire-owned session or restart its worker to load resources. A connected terminal Pi handles these in its own terminal. |
| `/export [path]` | Export native HTML, or current-branch JSONL for a path ending in `.jsonl`. Quote paths containing spaces. |
| `/session`, `/hotkeys`, `/changelog` | Show usage, workbench shortcuts or the release notes shipped with the installed Pi version. |
| `/quit` | Show how to leave the client. Closing the browser tab leaves Host sessions running. |
| `/share`, `/trust`, `/import`, `/bug` | Show the command to copy and run in Pi's terminal. |

Arrow keys select a completion. Enter, Tab or a pointer inserts it without submitting. Free-text
commands such as `/name` and `/export` show usage hints. Pi's public inventory supplies command
names and descriptions. Extension-specific argument completion requires support from Pi.

## New projects and prompt files

Choose the Host project directory on **New session**. **Create folder and start** creates a missing
directory and its parents when you submit. Pi resolves unpreviewed model defaults in the new
directory. If startup fails, the created folder can remain and untransferred input stays editable.

Use an `@` completion to insert a path in the sentence, including repeated references. Paths with
spaces are quoted. New session inserts absolute paths so changing the directory preserves the
selected reference. **Add project files** adds removable chips. Uploaded files with confirmed or
uncertain delivery survive Host restarts and session deletion. See [uploaded-file cleanup](host.md#uploaded-file-retention-and-cleanup).

## History and independent copies

**History** shows your inputs, replies and activity. **Other routes** appears at branch points.
Search includes earlier and alternate history. Open a point to preview it, then **Back to history**
to restore the search and position. **Switch branch…** in the title menu opens the same outline.

- **Continue / Edit in this session** changes the continuation point. **Carry branch summary**
  includes a summary with optional instructions. A confirmation protects an existing draft when an
  edit would replace it. Pi's skip-summary-prompt setting also applies here. Input added while a
  summary is pending stays in the draft. **Restore saved position** in the notice or palette
  returns to the latest saved point.
- **Fork into new session** copies up to the selected user input and restores that input's text
  and saved images for editing. **Clone into new session** includes its selected endpoint and opens
  an empty draft. The title menu and palette can also clone the current branch.

Continuing requires an idle session with no pending input or dialogs. Fork and Clone can copy
recorded history while the source continues running. For extension lifecycle differences, see
[Session lifecycle](extensions.md#session-lifecycle).

## Models and thinking

The picker displays cached choices while refreshing the current worker's catalog. A failed refresh
keeps cached choices available. Selecting a model follows Pi's effort defaults unless you chose a
level explicitly. For example, an explicit `xhigh` becomes `high` on a model that supports through
`high`. New sessions inherit visible model and effort choices or preview Pi's workspace defaults.
A virtual **Router** stays selected when a physical model answers. If a router disappears,
reopened sessions use Pi's physical-response recovery.

New-session discovery includes global and already-trusted project extensions. Pi handles new
trust decisions at startup. A connected terminal Pi supplies its own model catalog and effective
selection. Model cycling stays in its terminal. See [Share sessions with terminal Pi](extensions.md#share-sessions-with-terminal-pi).

## Model settings and login

**Manage models** opens Settings → Models. Save or clear Pi's startup model and thinking defaults
there. Project settings and per-model thinking preferences retain their native precedence.
**Model default** removes the global effort preference. Common models use Pi's ordered
`enabledModels` patterns and optional thinking suffixes. The picker lists matches first and
keeps the rest searchable. Changing defaults leaves the open session's selection intact.

**Next model**, **Previous model** and **Cycle thinking level** appear in palette search and
`/hotkeys`. Their shortcuts are Ctrl+⌘+M/P/R on macOS and Alt+Shift+M/P/R elsewhere.
Next model uses the owned worker's cycle order and effort defaults. Pi RPC currently lacks previous
model cycling. For owned workers, Pi also performs the thinking cycle. An attached Pi uses the
thinking setter for the same gesture. Cycle shortcuts work
from a message draft and respect open completions, dialogs, other editors and composition input.

Provider and model forms edit Pi's `models.json`, follow existing symlinks and preserve fields
outside the form. Invalid files and concurrent edits are reported before saving. Removing a
declaration leaves built-in models and credentials intact. A save refreshes availability. If the
refresh fails, the saved change remains on disk.

**Connect provider** opens provider search. Choose a method and follow its link, code or prompt.
**Remote login** identifies established cross-device methods. **Manage** on a saved provider
offers available methods and credential removal. Login is confirmed by Pi on the connected Host.
Removing a credential there leaves provider-side grants and environment or model-file keys intact.

## Runtime behavior settings

Settings → Behavior applies delivery, automatic compaction and retry to the selected Inspire-owned
worker and asks Pi to save global settings. Project overrides still apply. Other workers retain
their loaded values. Pi confirms the runtime change but does not report completion of the settings
file write. Repair a reported invalid settings file before Reload.

## Direct shell input

Send `!pwd` to run a shell command through an Inspire-owned Pi and include its result in subsequent
model context. Use `!!git status --short` to record and display output outside model context. Both
use Pi's working directory and Bash extension hooks. The shell card streams output, shows exit or
cancellation status, and offers **View full output** for truncated results. The input and result
remain in History after reopening. Shell input accepts text only.

One native shell can run alongside model work or compaction. Send remains available during a
shell-only run. **Stop** or Escape interrupts model work or compaction first, then a remaining
shell on the next Stop. A shell-only Stop preserves Pending input. An unresponsive extension
hook can require retiring the selected worker. Run shell input for a connected native Pi in its
original terminal. Browser Stop there requests agent interruption.

## Pending input and stopping

During model work, choose **Steer** to redirect the next turn or **Queue** to follow it. Select
the count above the Composer to focus Pending. **Copy** uses the full text, including any
truncated previews. **Return all** puts unconsumed Steer inputs, then Queue inputs, before the
draft. **Clear all** confirms before discarding queued input and leaves the draft and task intact.

Stopping model work recovers unconsumed input, including identifiable original images submitted
through Inspire. Undelivered files and project references also return. Pi-consumed images stay in
history. If ownership is uncertain, Inspire reports which recovery it could confirm. **Stopped**
indicates native cancellation and **Pi error** indicates failure. An unconfirmed Stop keeps its
uncertain status. Open dialogs, completions and context hints handle Escape first.

## Export

Choose **Export** in the title menu or **Export session** in the palette, select **HTML** for the
whole session or **JSONL** for the current branch, then **Download**. Export during a run captures
what is available at invocation. JSONL preserves native entries, embedded images and extension
metadata. Read-only sessions can export saved JSONL even when the project or external owner is
unavailable. HTML requires an available Inspire-owned worker.

Typed `/export [path]` accepts one destination, including `~/` and quoted paths. Its receipt offers
**Download** and **Copy path**. The download serves the generated snapshot even if the destination
file changes. Re-export after a Host restart or an expired download link.

## Compaction and reload

Manual and automatic compaction share an indicator. Pi determines completion and accepts Steer or
Queue input meanwhile. Stop requests native cancellation and recovers unconsumed Pending input.
A committed checkpoint survives a racing Stop. Successful Compact and Reload show a short
confirmation. Cancellation, failure and unknown outcomes retain their command result.

The context ring shows used tokens and capacity. Activate it or `/session` for **Session & usage**.
After compaction, `—` means Pi has yet to report updated usage. Reload restarts only the selected
idle Inspire-owned worker, including its extensions, skills, prompts and context files. To apply
Host configuration changes, see [Host restart scopes](host.md#host-and-terminal-maintenance).

<a id="updates"></a>

## Update checks

Settings → System checks Inspire, Pi and global/user extension packages. It shows installation
commands. After installing updates, **Check again** refreshes the result. **Restart Host to apply**
means the Host still has an older Pi version loaded. Reload the session to apply resource changes.

## Sessions and terminal use

Choose **Copy resume command** in the palette and run it in the project folder to open terminal Pi.
If the folder is missing, run the command in the new folder and choose **Fork** in Pi 1.5.2 or
later. A Pi worker started by Inspire, a connected native Pi and the **Terminal** panel have
separate lifecycles. The panel runs independent project shells. Terminal appearance is a browser
preference. **Persist output** and **Retention** belong to the Host's terminal service. Turning
saved output off removes its retained output. On macOS, enable **Option as Meta** to send
Escape-prefixed shell keys. Leaving it off preserves characters and accents. For terminal Pi
attachment, extension commands, dialogs and widgets, see [Extension adaptation](extensions.md).
