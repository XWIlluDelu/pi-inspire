---
purpose: The Host runs the user's installed Pi and adapts its runtime, commands, and extension UI for the browser.
covers:
  - server/pi-*.ts
  - server/runtime*.ts
  - server/session-projection.ts
  - server/pending-image-evidence.ts
  - server/pi-changelog.ts
  - server/extensions/**
  - shared/{contracts,commands}.ts
  - src/{api,store,events}.ts
  - src/components/{AppTopbar,ExportDialog,ExtensionDisplays,ExtensionUiDialog,ExtensionDialogContent}.tsx
  - docs/examples/task-board/**
  - tests/server/task-board-example.integration.test.ts
  - tests/web/extension-dialog-content.test.tsx
  - tests/server/pi-*.test.ts
  - tests/server/runtime*.test.ts
  - tests/web/{app,extension-displays,overlay-and-palette}.test.tsx
  - tests/web/{store*,events}.test.ts
---

# Pi integration

## Goal

Use Pi as the agent runtime and keep privileged local operations in the Host.

## Related contracts

- [[host-lifecycle]] — pairing, installation, services, diagnostics, and deployment.
- [[session-persistence]] — startup attestation, persisted entries, and writer admission.
- [[session-transport]] — HTTP/WebSocket observations and browser ownership.
- [[session-branches]] — same-file navigation and independent fork.
- [[composer]] — command feedback, input delivery, and Pending.
- [[model-settings]] — Pi-owned model configuration, defaults/common scope, and provider authentication.

## Runtime and agent ownership

Pi and user configuration own model tools, prompts, extensions and execution policy. Inspire provides
GUI projections and user controls. Its internal extension registers non-model commands for branch
navigation, worker-local model-catalog refresh, effective retry reads, pending-image evidence and
provider authentication. Attachments and selected prompt resources remain user input.

The Host resolves the external `pi` executable, imports its public SDK, and starts RPC workers from
that same package root. Startup checks the APIs it calls; version metadata is diagnostic. The
checkout's pinned development dependency is not a production fallback. Pi's normal agent directory,
project directory, settings, credentials, models, extensions, skills, prompts, and sessions remain
authoritative. Workers inherit the user environment defined by [[host-lifecycle]].

Direct RPC pipes are the default. Optional [[herdr-enhancement]] changes worker placement through a
private byte transport while preserving native execution and session authority. It also connects the
ordinary conversation composer to an existing native Pi terminal instead of starting another writer;
that terminal retains its process, queue and dialogs. The detailed connection and lifecycle contract
lives in [[herdr-enhancement]]. Direct mode remains independent of Herdr. Project terminals belong to the separate [[terminal]] daemon, outside Pi's
runtime and history. Session-bound file previews follow [[resource-preview]].

## Settings and native commands

The browser receives model availability and runtime state, not stored credential values. Typed
settings controls cover auto-compaction, auto-retry, and steering/follow-up delivery. Pi's worker and
`SettingsManager` own those values. Browser optimism is per field and selection/transport owner:
a stale failure cannot roll back a newer request, and a current failure reconciles against Pi.
Retry reads use the owning worker's public `getSettings()` through the hidden bridge, preserving its
project-trust and override decisions. A native setter acknowledgment is followed by an effective read;
that confirmation does not establish successful persistence. Behavior discloses this boundary and
the selected worker/global-save/project-override scope beside the controls.

Pi 1.3.0 exposes SDK settings flush/error APIs, but not the RPC worker's manager or a reliable
owning-write result. A load-blocked file may produce no new save error, and a flush can resolve with
a drainable write error. Per-change saved/failed feedback therefore remains blocked on a public
worker-owned persistence result; [[pi-capability-gaps]] tracks that requirement.

[[model-settings]] owns saved defaults, common scope, declarations and credential controls. Native
files and precedence remain authoritative; configuration is independent of login and current-session
selection. Authentication uses the current worker's provider definitions and public
`ModelRuntime.login/logout` in a separately owned operation sharing native storage. The bridge carries
interactions outside model input and retains native cancellation/worker stop fences. Browser payloads
and errors omit stored or resolved keys/tokens.

Pi RPC enumerates extension, prompt, and skill commands but not interactive built-ins.
`shared/commands.ts` reserves the installed interactive built-in vocabulary before resource dispatch,
matching Pi's interactive client. Within resources, preserve Pi's first wire owner. Namespaced
extension commands remain available. Names are case-sensitive. Exact inventory matches also admit
Pi-registered Unicode and punctuated names without classifying other filesystem paths as commands.
First-message completion hides native commands needing a session without exposing colliding resources
instead. Browser commands reuse
existing surfaces, including Models settings for `/scoped-models`, `/login` and `/logout`; Host
commands own compaction, export and reload. Terminal-only commands expose precise copy/open guidance.
`/bug` neither uploads a report nor sends its description to the model.
The public command inventory is [Pi commands](../../docs/pi-commands.md).

For owned RPC workers, the Host rejects unknown command-shaped text at the prompt boundary and
dispatches direct `!`/`!!` input to native Bash. Existing TUI connections instead direct shell input
and interactive built-ins to the original terminal; `sendUserMessage` is not the TUI shell/built-in
submit handler. The Host normalizes resource-command separators, and revalidates command ownership
after reload/worker replacement. Snapshots and slash-command admission/delivery read the worker's
current loaded inventory. Resource-command completion refreshes browser discovery even during model
work, without settling that work or Pending. Native in-process reload therefore does not require a
GUI worker replacement merely to discover its commands.
`/compact` also has a first-message path using its standalone operation lifecycle. The browser
acknowledges typed Host commands immediately; their HTTP results remain completion-driven, outside
prompt confirmation timeouts. Read-only/local
commands remain available through delivery phases; Reload and a new manual Compact refuse active Pi
work. Typed native commands and shell input reject artifacts without consuming them; palette actions
have an independent draft owner under [[composer]].

Compaction completes according to Pi, outside browser prompt deadlines. Standalone manual Stop uses
Pi's generic `abort`, retaining the same worker and extension-local state when cancellation cooperates.
The abort acknowledgement is not the compaction's completion boundary: Pi's terminal event and compact
response determine cancellation versus completion, with persisted completion winning a Stop race.
Only explicit cancellation has a short settlement grace; an unresponsive hook retires through the
existing confirmed-stop/writer fence. Normal compaction has no time budget. Reload replaces an idle worker and invalidates
resource/model inventories. Opening the model picker instead refreshes the current worker through
public `ExtensionCommandContext.modelRegistry.refresh({ signal })`, followed by RPC
`get_available_models`; native `set_model` reads that same available snapshot. The narrow internal
command/status pair is worker/session/nonce-owned, hidden from user command/status inventories,
coalesced per worker, and independent of the persistence/branch mutation lane. A 15-second abort
budget bounds catalog discovery without stopping Pi. Pi retains extension registrations, credentials,
offline/network policy and usable cached catalogs.
The owning RPC worker supplies its model list and accepts native RPC model changes. Connected TUI
owners instead use the existing activity receiver and public model/thinking functions, as specified in
[[herdr-enhancement]]. Both return effective model and thinking values rather than echoed arguments.
[[model-settings]]
owns selection/discovery semantics; [[composer]] owns cached-first controls and feedback.
Export content, source protection and
managed downloads belong to [[session-branches]], with controls/receipts in [[composer]].

`/changelog` reads the installed package's matching version section, not a dependency fallback or
remote latest-release feed. Public extension command enumeration has no argument-completion hooks;
Inspire does not infer callbacks or patch Pi internals to manufacture them. [[composer]] owns native
argument assistance and explicit resource preparation. In Pi 1.3.0, `registerCommand()`
accepts `getArgumentCompletions`, but both RPC `get_commands` and public `ExtensionAPI.getCommands()`
return `SlashCommandInfo` metadata without callable completion hooks. `addAutocompleteProvider()`
is a no-op in RPC. Generic completion needs a public current-worker command-completion invocation
(name/prefix to completion items); package-specific guesses and private runner access are excluded.

## Extension UI reuse and source DIY

The standard dialog content has a controlled props-only boundary: request/value, pending/error,
value change, respond and cancel callbacks. The connected wrapper owns session/request identity,
communication, form lifetime, deadlines and modal focus. Reusing the body does not import the global
store or grant runtime control. Existing select/input/editor/confirm behavior remains unchanged.

Prefer native RPC primitives when they meet the use case, then declarative typed display rules.
Nested-property display is not a general subagent-management API. A purpose-built interaction can
use source DIY: a Pi extension owns state and namespaced commands, a small adapter maps admitted data
and available actions, and a React component renders list/detail UI. Actions require declared
capability plus current inventory and use `sendPreparedCommand` to preserve drafts/artifacts.

The task-board example demonstrates this complete path with cancellable local timers and editable
notes, persisted as native custom messages. Startup and native tree navigation cancel its local
demo timers and restore only the selected branch’s saved task state; returning does not resume
process-local work. Its adapter resets local selection/pending/errors per
session/view/transport owner. A missing loaded snapshot has an explicit Show tasks command, not a
new full-history index or automatic selection-side command. The same view can be mounted in the
responsive Context pane; the stock frontend adds no Tasks panel. Pi authors retain scheduling and
permission choices. Native confirmation is the first permission-request surface; there is no new
permission-list panel, runtime React SDK or agent scheduler.

[The extension guide](../../docs/extensions.md#choose-the-smallest-integration) links the files,
data/action flow, source mounting and build/load/reload verification instructions.

## Startup and resource diagnostics

Recognized Pi startup extension-load failures identify the failed resource and repair/disable action
in the existing error surface, rather than only reporting a closed RPC stream. Invalid-settings
startup diagnostics identify the settings file and advise repair and Reload, including when Pi
continues with in-memory defaults. Retention uses the bounded stderr tail; disclosure strips terminal
controls and caps each diagnostic category at three entries and resource paths at 300 characters.
Exception bodies, stack traces, source excerpts and unrelated stderr remain Host-only, not browser
errors or notices. Startup failures retain the raw tail in the Host console error detail. Unknown stderr is not interpreted as structured runtime state.

The internal bridge reads public `ctx.isProjectTrusted()` on `session_start` (including native
reload) and warns when trust-protected project settings/resources are skipped. Trust remains Pi-owned:
the notice directs the user to terminal `/trust` and then session Reload, without granting trust or
claiming an omitted-resource inventory. Context files and Pi's pre-trust session-directory lookup
retain their native exceptions.

Invalid-skill omissions lack attributable diagnostics in Pi 1.3.0 RPC and extension contexts.
The SDK's ResourceLoader diagnostics belong to its own loader. GUI omission reasons require the
current worker to expose resource identity and native reason, rather than another filesystem scan.

## Direct shell execution

`!` and `!!` use the selected worker's native `bash` RPC with `excludeFromContext`, preserving Pi's
cwd, `user_bash` hooks, extension results/custom operations and execution policy. Id-tagged
`bash_execution_update` deltas belong to their matching request. The live preview is bounded; the
final result preserves exit status, cancellation, truncation and full-output path.

Pi owns the durable `BashExecutionMessage` and context inclusion. Results produced during agent
streaming may remain live until Pi flushes them at `agent_end`; the Host reconciles live and durable
ownership without duplicate presentation or replacing Pi's timestamps. Excluded results remain
visible in the branch and input history after reopening.

Shell activity is separate from model/compaction state. Shell-only Stop calls `abort_bash` without
recovering/dequeuing Pending or aborting the agent. Model/compaction Stop retains first ownership
when both run. An extension hook may block before Pi installs its Bash abort controller; dialogs
remain answerable, and explicit Stop retires only the owning worker if native cancellation cannot
finish. An unacknowledged retired request reports unknown acceptance rather than inviting an
automatic retry.

## RPC transport and observations

- JSONL framing accepts bounded valid-UTF-8 objects and assembles lines without repeatedly copying
  prefixes. An oversized unterminated line retires its worker, limiting Host memory and loop work.
- A response must match a pending ID, exact command, and explicit success value. Malformed,
  mismatched, oversized, or unexpectedly closed streams retire the worker rather than skipping
  frames with ambiguous ordering.
- Startup and stdin delivery have admission/transport bounds. Pi mutations have no generic response
  deadline: preflight compaction, authentication, hooks/dialogs, export, and branch handlers may
  take arbitrarily longer than ordinary reads.
- Read-only waits default to 30 seconds. Expiry retires the caller but retains the exact ID/command
  for a valid late response. All tracked requests, including expired observers, share a 256-entry
  cap; entries are not evicted to admit more work.
- An explicitly bounded mutation wait reports an unknown outcome without stopping the worker.
  Actual stream/stdin failure or child loss initiates retirement. A response deadline alone does
  not establish stream failure or process exit.

During compaction, Pi's public prompt path may refuse input. The Host holds a bounded temporary
queue owned by that worker and branch selection. Original preflight input stays first; only an actual
active agent receives Steer/Queue directly. After standalone manual compaction, the first surviving
input starts a prompt. Host-held input is not history and cannot cross worker/branch replacement.

Stop recovers Pending under [[composer]] through public `clear_queue` before `abort`; abort alone can
continue queued work. Recovery and Stop bypass blocked persistence/prompt-hook lanes, reject new
deliveries while Stop runs and retire a preflight worker when native abort cannot interrupt its hook.
Failed clear reports failure and retires the worker rather than leaving a live queue.
A prompt written to Pi but stopped before its receipt remains acceptance-unknown. Unwritten image
preparation remains with its existing owner: worker retirement rejects retained preparations back to
staged originals rather than deleting them. A Stop epoch is rechecked after asynchronous preparation
and at the prompt write boundary, so completed Stop cannot admit an older preparation. A genuinely
new post-Stop send remains available.

Pi dequeues text, not image bytes. Image ownership combines observed queue admission, original
submitted content, raw `message_start` consumption and the dequeue-response fence. Preparation records
a native append cursor. Ambiguous clearing reads subsequent persisted identity/content hashes and
image counts as bounded records without image bodies. Raw events take precedence; persisted evidence
cannot resolve a message suspended before its event. Recovery transfers owned original images to
staged handles; discard, consumption and retirement release only worker-owned copies. [[composer]]
owns recovery merging, copying and unresolved-image feedback.

An input hook can also accept a prompt without agent lifecycle events: an idle/empty Pi observation
may clear that queued admission only while the same worker and sole pending prompt still own it.
Failure of this observation does not reject an accepted prompt.

Direct-worker retirement requires observed leader exit (or proven spawn failure) and completed
process-tree signaling. Herdr additionally requires its worker scope to be empty. Replacement and
recovery writes stay fenced while termination is pending or rejected. Protocol failure notifies
Runtime in either case and retains the original stop result. [[state-ownership]]
records these observation/execution/retirement distinctions.

## Persistence and worker identity

Pi message, tool, queue, retry, compaction, session, extension UI, and `entry_appended` events cross
the validated Host interface. Persistence expectations include extension `custom`, system/tool-loadout,
and `usage` entries even when they are not transcript rows. Pi statistics remain authoritative for
cache-warming and unknown usage kinds.

Every claimed persisted entry is matched exactly. If disk observation arrives first, bounded worker
`get_entries` may attest only an exact persisted-JSON prefix of its contiguous chain from the trusted
leaf. Worker-only trailing entries wait for disk observation; claims arriving during lookup are
consumed only through the observed prefix. Diagnostics record identities/counts, not entry payloads.
The complete reconciliation and startup rules are in [[session-persistence]].

Replacing a worker retires its subscriptions. New-session startup retains a provisional slot until
the public session identity is finalized. Independent fork leaves the source worker running.

## Extension interactions

Standard dialogs use browser modals. Each request belongs to its session and originating worker.
Responses travel through a per-slot FIFO separate from persistence mutations; the Host rechecks
request ID, session, process instance, expiry, and conflict state before sending once and removing it.
When Stop retains the worker, cancel the captured pending requests through the same process-bound
response FIFO as explicit Cancel, sending `cancelled: true` before removing each handled ID. Questions
created during cancellation remain answerable. Worker retirement/replacement or close clears its
remaining requests; expiry removes timed-out requests. Model settlement leaves requests intact
because independent extension commands may still await an answer. Fork leaves source
requests with their worker. Startup restrictions follow [[session-persistence]] and the
[adaptation guide](../../docs/extensions.md#startup).

Select dialogs support arrow-key choice and Enter, alongside direct pointer/touch selection.
Confirmation has two visible choices, No and Yes; Escape cancels. On narrow viewports, browser Back
uses the same cancellation path, preserving any suspended Settings or Context surface. Pending or
failed cancellation keeps the question visible and its return layer usable. Input and multiline dialogs retain
Submit and Save. A request with a deadline shows its remaining time without restarting the expiry on
reopen or reconnect. Pi 1.3.0 does not send request-attributed extension cancellation to RPC
clients. Aggregate `ui_prompt_start/end` callbacks carry kind/title but no RPC request ID; concurrent
same-title dialogs cannot be distinguished. A request-ID-bearing dismissal event is still needed.

Keyed status text is bounded at Host retention, restored on reconnect, ordered in a compact topbar
trigger at every viewport width, and cleared with its worker. Native in-process reload also clears
prior statuses/widgets, including shutdown updates, before the configured extensions publish startup
UI. The first-loaded internal bridge signals Pi’s public reload startup boundary without replacing
its worker or branch view; subsequent startup values remain current. Click, tap or keyboard activation opens
full status text; absent status takes no space. String-array widgets
preserve their key and above/below-Composer placement, replacing or clearing by key. Their supplied
text and Copy are primary; internal keys and paths are not manufactured headings. Oversized keys are
rejected to avoid identity collisions; terminal control sequences are display-cleaned.

TUI component factories stay terminal-only. Malformed, oversized, and unknown one-way displays retain
bounded attributable raw inspection. Unknown response-bearing methods use the cancellable dialog
fallback. Persisted generic extension content uses available extension attribution, otherwise
**Extension**, with raw method/type/payload inside the body. Displayed custom messages follow
[[conversation]]. Extension failures retain their originating lifecycle/operation diagnostic.

The public [adaptation guide](../../docs/extensions.md) covers commands, dialogs, text widgets,
custom cards, lifecycle differences, and source customization. Dedicated frontend controls require
source changes; the runnable native-UI example illustrates shared primitives.

## Checks

The installed-Pi integration tests exercise read-only preview, real RPC state/queues and `clear_queue`,
incremental entries, tree/model/command/statistics APIs, dialog and one-way UI methods, offline
extension-supplied compaction, session-directory replacement, switch, and native fork. Runtime tests
cover same-file navigation and independent SessionManager fork with an active source worker.
Native PTY coverage checks actual image content at `before_agent_start`, browser input preserving
ordinary and Stop-restored terminal drafts, native dialog blocking and agent-only Stop. Its Herdr
terminal transport is a fixture, not a full Herdr installation check. The native RPC UI integration
checks that retained-worker Stop resolves the Pi dialog promise and preserves a new independent question.
[[dependency-boundaries]] explains runtime and development ownership;
[[native-command-compatibility]] describes dispatch and native regression setup.
