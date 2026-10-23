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

Direct RPC pipes are the default. Optional [[herdr-enhancement]] changes worker placement or connects
the composer to an existing Pi terminal while preserving native process, queue and dialog ownership.
Project terminals use the separate [[terminal]] daemon; previews follow [[resource-preview]].

## Settings and native commands

Pi's worker and `SettingsManager` own auto-compaction, retry and steering/follow-up delivery.
Controls read effective values after native setters. Optimistic state belongs to its field and
session/transport owner; stale failures cannot roll back newer requests, and current failures
reconcile with Pi. Retry reads use the owning worker's public `getSettings()` to retain its trust
and override decisions.

An effective-value read confirms runtime state, not persistence. Controls disclose their
worker/global-save/project-override scope. Pi 1.3.0 lacks a reliable worker-owned persistence result;
[[pi-capability-gaps]] records the missing interface and why SDK flush/error APIs are insufficient.

[[model-settings]] owns saved defaults, declarations, selection and authentication. Login/logout
uses public `ModelRuntime` methods with the worker's provider definitions and native storage.
The separately owned operation carries interactions outside model input, retains cancellation and
worker-stop fences, and excludes stored/resolved keys and tokens from browser payloads and errors.

### Command dispatch

RPC lists extension, prompt and skill commands but omits interactive built-ins. Reserve the installed
built-in vocabulary before resource dispatch, then retain Pi's first wire owner for each resource
name. Names are case-sensitive; exact inventory matches admit namespaced, Unicode and punctuated
names without treating arbitrary filesystem paths as commands. First-message completion hides
session-dependent commands without exposing colliding resources.

Browser commands open existing surfaces; Host commands run compaction, export and reload.
Terminal-only commands give copy/open guidance. `/bug` does not upload a report or send its text to
the model. [Pi commands](../../docs/pi-commands.md) is the user-facing inventory.

For owned workers, reject unknown command-shaped input and route `!`/`!!` to native Bash. Connected
TUI sessions direct shell input and interactive built-ins to the original terminal: `sendUserMessage`
is not that terminal's submit handler. Normalize resource separators and recheck the worker's current
inventory at admission and delivery, including after reload. Resource completion can refresh browser
discovery during agent work without settling work or Pending.

Typed Host commands acknowledge immediately and await completion outside prompt timeouts. `/compact`
also supports first-message startup. Read-only/local commands remain usable through delivery phases;
Reload and a new manual Compact refuse active Pi work. Typed native commands and shell input reject
artifacts without consuming them; palette actions have the draft ownership defined in [[composer]].

### Compaction, reload and model discovery

Compaction follows Pi completion without a generic time budget. Manual Stop calls native `abort`
and keeps a cooperative worker and its extension state. Pi's terminal event and compact response
settle the operation; persisted completion wins a Stop race. Only explicit cancellation has a short
settlement grace, after which an unresponsive hook uses the confirmed-stop/writer fence.

Reload replaces an idle worker and invalidates resource/model inventories. Opening the model picker
instead calls public `ExtensionCommandContext.modelRegistry.refresh({ signal })` in the current
worker, then `get_available_models`; `set_model` uses that available snapshot. The hidden bridge
command/status pair is worker/session/nonce-owned, coalesced per worker and independent of the
persistence/branch mutation lane. Its 15-second discovery budget does not stop Pi. Native extension registrations,
credentials, offline policy and usable cached catalogs remain authoritative.

Owned RPC and connected TUI controls return effective model/thinking values. [[model-settings]]
owns selection and discovery semantics; [[herdr-enhancement]] owns the TUI receiver;
[[composer]] owns control feedback. [[session-branches]] owns exports and download protection.

### Installed resources and capability gaps

`/changelog` reads the installed package's matching version section. Generic argument completion
needs a public current-worker callback invocation: Pi 1.3.0 command inventories expose metadata,
not callable completions, and RPC autocomplete registration is a no-op. Keep that requirement in
[[pi-capability-gaps]]; [[composer]] owns supported argument assistance and resource preparation.

## Extension UI reuse and source DIY

Standard dialog bodies accept controlled props for values, pending/error state and response/cancel
callbacks. Their connected wrapper owns session/request identity, communication, lifetime, deadlines
and modal focus. Reusing the body grants no runtime control or global-store dependency.

Prefer native RPC primitives, then typed declarative displays. Purpose-built source customization
uses a Pi extension for state and namespaced commands, an adapter for admitted data/actions, and a
React view. Actions require both declared capability and current command inventory;
`sendPreparedCommand` preserves drafts and attachments. Nested-property display alone does not
provide subagent management or scheduling.

The [task-board example](../../docs/extensions.md#choose-the-smallest-integration) demonstrates
persisted custom messages, editable notes and cancellable local timers. Startup/tree navigation
cancels local timers and restores the selected branch's saved state without resuming process-local
work. UI state belongs
to its session/view/transport. An explicit Show tasks action obtains a missing snapshot; selection
does not silently issue commands or index full history. The view can mount in Context without
adding a stock Tasks panel or runtime React SDK. Native confirmation remains the permission surface;
extension authors own scheduling and permissions.

## Startup and resource diagnostics

Recognized extension-load and invalid-settings failures identify the resource and repair/disable
or Reload action, including when Pi falls back to in-memory settings. Browser diagnostics are
sanitized, bounded summaries from stderr; exception bodies, stacks, source excerpts and unrelated
stderr stay in Host diagnostics. Unknown stderr is not structured runtime state.

The internal bridge reads public `ctx.isProjectTrusted()` at `session_start`, including reload.
When trust skips protected project settings/resources, direct the user to terminal `/trust` and
session Reload. Pi owns the decision and its context-file/session-directory exceptions.

Explaining omitted invalid skills needs attributable current-worker resource diagnostics. Another
SDK loader or filesystem scan cannot supply the worker's omission reasons; the remaining interface
is recorded in [[pi-capability-gaps]].

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

Select supports arrows, Enter and pointer/touch choice. Confirm shows No/Yes; Escape and narrow-screen
Back cancel while preserving a suspended Settings or Context surface. Pending/failed cancellation
keeps the question and return layer usable. Input/editor dialogs retain Submit/Save. Within bounded
overlay height, editors and choice lists yield space before actions; editors keep a four-line
minimum. Long bodies and diagnostics remain scrollable and keyboard-reachable, with input errors
inside the owning form. Resizing preserves draft and focus.

Show remaining deadline time and retain the original expiry across reopen/reconnect. Pi 1.3.0 lacks request-attributed
extension dismissal; aggregate prompt callbacks cannot identify concurrent same-title questions.
[[pi-capability-gaps]] retains the requirement for a request-ID-bearing cancellation event.

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

The [adaptation guide](../../docs/extensions.md) provides command, dialog, widget and customization
examples. Declarative adapters use [[tool-presentations]]; purpose-built frontend interactions use
source customization.

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
