---
purpose: The Host runs the user's installed Pi and adapts its runtime, commands, and extension UI for the browser.
covers:
  - server/pi-*.ts
  - server/runtime*.ts
  - server/session-projection.ts
  - server/extensions/**
  - shared/{contracts,commands}.ts
  - src/{api,store,events}.ts
  - src/components/{AppTopbar,ExtensionDisplays,ExtensionUiDialog}.tsx
  - tests/server/pi-*.test.ts
  - tests/server/runtime*.test.ts
  - tests/web/{app,transcript-inspection}.test.tsx
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

## Runtime and agent ownership

Pi and user configuration own model tools, prompts, extensions, and execution policy. Inspire adds
GUI projections and explicit user controls, not LLM tools, system prompts, or delegation policy.
Its internal branch-navigation extension registers a non-model command for GUI navigation.
Explicit attachments and selected prompt resources remain user input.

The Host resolves the external `pi` executable, imports its public SDK, and starts RPC workers from
that same package root. Startup checks the APIs it calls; version metadata is diagnostic. The
checkout's pinned development dependency is not a production fallback. Pi's normal agent directory,
project directory, settings, credentials, models, extensions, skills, prompts, and sessions remain
authoritative. Workers inherit the user environment defined by [[host-lifecycle]].

Direct RPC pipes are the default. [[herdr-enhancement]] can change worker placement through a private
byte transport while preserving native command execution and the same session authority. It adds no
separate session list, collaboration scheduler, or message-routing service; direct mode remains
independent of Herdr.

Project terminals belong to the separate [[terminal]] daemon. They are human shells, outside Pi's
runtime and history; a Pi prompt or extension receives no implicit terminal-control authority.
Session-bound file previews follow [[resource-preview]].

## Settings and native commands

The browser receives model availability and runtime state, not stored credential values. Typed
settings controls cover auto-compaction, auto-retry, and steering/follow-up delivery. Pi's worker and
`SettingsManager` own those values. Browser optimism is per field and selection/transport owner:
a stale failure cannot roll back a newer request, and a current failure reconciles against Pi.

Pi RPC enumerates extension, prompt, and skill commands but not interactive built-ins.
`shared/commands.ts` reserves built-in names before resource dispatch, matching Pi's interactive
client. Namespaced extension commands remain available. Browser commands reuse existing surfaces;
Host commands perform compaction, HTML export, and resource reload. Terminal-only commands expose
copy/open guidance. `/bug` does not upload a report or submit its description as a model prompt.
The public command inventory is [Pi commands](../../docs/pi-commands.md).

The Host rejects unknown command-shaped text and shell syntax at the prompt boundary, normalizes
resource-command separators, and revalidates command ownership after reload/worker replacement.
`/compact` also has a first-message path using its standalone operation lifecycle.

Compaction completes according to Pi, outside browser prompt deadlines. Because Pi has no public
`abort_compaction` RPC, cancellation stops only its worker and classifies that compact operation as
cancelled. A fresh worker resumes from JSONL on demand. Reload replaces an idle worker and invalidates
resource/model inventories. Export and reload share writer admission; [[composer]] specifies their
availability and user feedback.

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

Explicit Stop bypasses a blocked persistence lane and can retire a preflight worker when Pi's ordinary
abort cannot interrupt a hook. A prompt stopped before its receipt remains acceptance-unknown.
An input hook can also accept a prompt without agent lifecycle events: an idle/empty Pi observation
may clear that queued admission only while the same worker and sole pending prompt still own it.
Failure of this observation does not reject an accepted prompt.

Direct-worker retirement requires observed leader exit (or proven spawn failure) and completed
process-tree signaling. Herdr additionally requires its worker scope to be empty. Replacement and
recovery writes stay fenced while termination is pending or rejected. Protocol failure notifies
Runtime in either case and retains the original stop result. [[operation-lifecycle-ownership]]
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
Expiry and explicit abort, replacement, stop, or close also remove pending requests. Model settlement
leaves them intact because independent extension commands may still await an answer. Fork leaves source
requests with their worker. Startup restrictions follow [[session-persistence]] and the
[adaptation guide](../../docs/extensions.md#startup).

Keyed status text is bounded at Host retention, restored on reconnect, ordered in the desktop topbar,
and cleared with its worker. String-array widgets preserve their key and above/below-Composer
placement, replacing or clearing by key. Oversized keys are rejected to avoid identity collisions;
terminal control sequences are display-cleaned.

TUI component factories stay terminal-only. Malformed, oversized, and unknown one-way displays retain
bounded attributable raw inspection. Unknown response-bearing methods use the cancellable dialog
fallback. Persisted generic extension content uses available extension attribution, otherwise
**Extension**, with raw method/type/payload inside the body. Displayed custom messages follow
[[conversation]]. Extension failures retain their originating lifecycle/operation diagnostic.

The public [adaptation guide](../../docs/extensions.md) covers commands, dialogs, text widgets,
custom cards, lifecycle differences, and source customization. Inspire does not inspect third-party
package names or provide arbitrary executable frontend plugins.

## Checks

The installed-Pi integration tests exercise read-only preview, real RPC state/queues and `clear_queue`,
incremental entries, tree/model/command/statistics APIs, dialog and one-way UI methods, offline
extension-supplied compaction, session-directory replacement, switch, and native fork. Runtime tests
cover same-file navigation and independent SessionManager fork with an active source worker.
[[dependency-boundaries]] records tested Pi versions; [[native-command-compatibility]] records
command and delivery evidence.
