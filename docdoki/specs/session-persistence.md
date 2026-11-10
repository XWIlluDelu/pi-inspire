---
purpose: "Pi JSONL remains authoritative while previews, independent workers, startup reconciliation, and shared use with other Pi processes keep each view on its own branch."
covers:
  - server/runtime*.ts
  - server/external-session.ts
  - server/attach-control.ts
  - extensions/inspire-session-bridge.ts
  - server/pi-rpc.ts
  - server/session-{projection,preview,jsonl}.ts
  - server/persisted-json.ts
  - server/resources.ts
  - tests/server/runtime*.test.ts
  - tests/server/session-{projection*,preview,jsonl}.test.ts
  - scripts/benchmark-projection-reads.mjs
  - tests/server/pi-{rpc,compat.integration}.test.ts
---

# Session persistence and worker ownership

## Goal

Continue sessions without copying their durable state or weakening the filesystem and worker trust
boundary. Catalog and navigation obligations remain in [[session-continuity]]; branch actions are in
[[session-branches]].

## Read-only preview and independent workers

Opening a session first projects its active branch through Pi's read-only parser and context
builder, without writing JSONL or waiting for extensions. Transcript virtualization bounds mounted
history. Auxiliary project-discovery writes and upload-retention registration are not prerequisites
for history reads or writer admission.

Valid retained history remains readable when its project directory is missing, is not a directory,
or cannot be resolved. The snapshot reports `readOnlyReason: workspace-unavailable`; neither a Pi
worker nor project model discovery starts. Worker-backed mutations and independent Fork/Clone reject
at admission. The history source must still be valid: missing or corrupt JSONL keeps its own error.

For an available project, the independent worker warms outside the selection critical path.
`runtime_ready` replaces the preview with authoritative RPC state only for the still-selected
session and after startup attestation. Reopening a workspace-unavailable session rechecks its
recorded directory. If restored, retain its resolved physical root, renew the resource view, and use
ordinary startup admission. Do not create the directory, substitute the Host cwd, or rewrite the
session header to make history executable.

Each selected or active session has an independent runtime; switching conversations leaves
background work running. Before startup, resolve one immutable physical workspace root for Pi,
project files, attachment context, resources and Git inspection. Later symlink retargeting must not
split those operations across roots, and the browser does not register a second workspace path.

Live messages acquire durable identity through exact native persistence claims or worker
witnesses. Bind the live lifecycle ID to the verified entry ID before retiring its overlay;
timestamps, roles and even equal content are not message identity. Browser projections may be
lossy, so do not infer that two messages are the same from their rendered content.

## New-session materialization

Pi reserves a path before creating JSONL, so model, thinking, name, extension state and the first
message may exist only in the creating worker. Explicit model/thinking choices enter as startup
arguments. Until disk records them, snapshots keep the explicit thinking choice instead of the
empty projection's structural `off`; without an explicit choice, use live worker state.

Only `newSession` may open a healthy empty projection for an absent path. Read the creating worker's
bounded contiguous `get_entries` once, covering a file appearing during setup, then attest each
observed complete-line prefix against that state. Header version, session ID, cwd, root parent,
entry chain and physical append lineage must agree. Header-only and multi-write flushes keep this
transition open until disk catches up. Disk-before-event entries keep correlation and consume
their exact matching event once. Mismatch stops the worker; existing-session open treats absent
JSONL as an error. Once materialized, normal inode/version/append rules apply.

An unselected, idle, never-materialized session has no catalog identity and may be abandoned by LRU;
selected or running work keeps its worker.

## Startup trust boundary

Capture a trusted projection tail or empty baseline before constructing the process. Immediately
before `rpc.start()`, reconcile again and require unchanged file identity/stat version, revision,
tail, fingerprint and committed bytes. Projection readers remain serialized behind this boundary.

After start, Pi and its extensions may persist entries. Require a complete, direct, contiguous
append within the existing RPC transport limit, without an extra startup size/count cap or entry-type
whitelist. `get_entries`, `get_state`, and disk must agree on every entry, parent, final leaf, session,
path, thinking level and append lineage. After the final filesystem observation, the same worker must
still own the slot and remain RPC-available before readiness or a new writer baseline is published.
A retired worker cannot reset failure to idle or emit `runtime_ready`.

RPC/disk disagreement, incorrect lineage or values, identity/path changes, incomplete entries and
rewrites stop the worker. Legitimate extension persistence is allowed. Attestation proves state
equivalence at startup. Later appends by independent Pi instances follow the ordinary same-file
prefix rules below.

A response-bearing `extension_ui_request` before RPC startup completes is unsupported. Stop and
clean the child immediately and return `PI_STARTUP_RESPONSE_UI_UNSUPPORTED` instead of exposing an
unanswerable dialog or waiting for timeout. One-way startup UI remains allowed.

## Persistence ownership

### Complete appends

The writer baseline includes exact file identity/source version and observed physical bytes.
Every Pi `message_end`, `compaction_end`, and `entry_appended` persistence event enters one expectation
ledger; match each entry's exact persisted-JSON content, not merely its id or type. If disk appends arrive
first, request the owning worker's bounded `get_entries` delta from its trusted leaf. Accept only
an exact persisted-JSON prefix of that contiguous worker chain.

A worker may be ahead of the observed disk prefix. Accept its suffix only after later reconciliation
observes and proves it. Claims arriving during witness lookup are consumed only through the observed
prefix; later claims remain queued. Retire matched claims by identity, because an earlier claim may
be cancelled while a later receipt is pending. Within a fully witnessed prefix, interleaved metadata
must not block matching ordinary message claims and binding their live IDs. Retain witnessed
ordinary messages whose completion events have not arrived, so those events adopt the existing
durable entries instead of creating duplicate overlays or future claims. Legitimately repeated
messages keep their distinct entry identities. The verified entry identity must also reach a completion event whose presentation is queued behind
earlier reconciliation; consuming its persistence claim must not lose that association before the
live overlay exists.

Explicit reconciliation, filesystem/poll hints and watch-health observations share one FIFO through
reading, asynchronous ownership verification and baseline commit. Coalesce hints while a consumer
is pending. Retired projections/workers cannot commit late witnesses or deferred receipts. Startup
attestation uses its separate suspended-reader boundary.

### Partial writes

Owned partial persistence preserves exact prefix/tail continuity and requires exact final-entry
provenance. Retain the last complete history and report persistence as pending until the write
completes. Elapsed observation time does not establish corruption or justify stopping the writer;
operations requiring complete persistence wait or refuse without restarting it.

Direct native Bash may hold this pending state while its worker remains current, even when idle
and without a persistence event. Its final entry still requires an exact worker/claim witness.
With an exact pending append claim from the sole worker, the projection may extend its verified
SHA-256 state and immutable normalized entry/message prefix. Otherwise it rereads and verifies the
committed bytes before parsing a suffix.

### Unchanged sources and read reuse

Ordinary snapshots, History pages and lazy resource-message reads may reuse a healthy verified
projection after a fresh non-following check of the regular file's device, inode, size, mtime and
ctime. Changed or unhealthy sources undergo byte validation in the same FIFO. Forced startup,
writer admission, Fork and explicit recovery keep their full validation. Lazy resource reads
recheck slot, view and revision before and after reconciliation.

A metadata-only observation may refresh the same worker's source version only after stable
full-byte revalidation of the same filesystem object, with healthy complete contents, no unresolved
tail or conflict, and the exact prior writer baseline still current. An owned hash prefix alone
is insufficient. This admits no entry, consumes no claim, and changes neither history revision nor
browser view. An identical-byte in-place rewrite is indistinguishable from timestamp-only movement
and is treated as unchanged state, not attributed to a writer. Startup source-version checks and
incomplete-tail continuation rules, including bounded new-file materialization, remain unchanged.

### Appends from other Pi processes

Other Pi processes may append to the same session at any time. Growth of the same file object, with
the verified prefix intact, is valid session use even when the entries are not the worker's: the
baseline advances and the worker keeps running. Diagnostics record the ownership decision without
entry content. A worker whose actual leaf then differs from the saved default records it as its
navigation lease, so its view, prompts and model context stay on its own branch. Query that worker
from a cursor it has already seen, not another process's new file tail. A failed leaf read retains
the last known worker position instead of silently adopting the saved default. Another process's
incomplete line is not a conflict, but nothing is written after it until it completes.

### Conflicts and uncertain writes

Duplicate identities, missing/forward parents, content or incomplete-tail rewrites, replacements
even with identical bytes, and an owned partial line that is overwritten keep the last-good
projection and block writing.

After an RPC mutation frame is written, stream failure or child loss leaves acceptance unknown.
Confirm termination, reconcile disk in the operation lane and retain a conflict; do not retry or
restage the input. An observer timeout proves neither failure nor exit. Conflicts survive
`agent_settled` and other terminal events until explicit recovery clears them.

## Worker lifetime and runtime boundaries

Inspire never starts a second worker for a session it owns or modifies source JSONL while that
runtime owns it. The fork helper uses only a private verified snapshot and a new destination.
`RuntimeController` owns the registry, selection, mutation gates and command facade. Its bounded
collaborators own slot construction, process identity, attestation, lifecycle, reclamation and
reconciliation; none keeps a parallel catalog, projection authority or persistence lane.

Unselected idle workers form a three-entry LRU warm cache and restart from Pi's file after reclamation.
Reclamation also drops their reloadable transcript projections. Busy workers, accepted prompts
awaiting lifecycle events, in-flight Host operations, and workers awaiting or consuming extension
input are never reclaimed. An attached live Pi connection is not part of the owned-worker LRU:
leaving and returning to its session retains that binding while the instance still corresponds to
the viewed branch. Detail subscriptions retain views under [[session-transport]].

## Shared-session admission

### Viewed position

Entering a session shows its saved default branch, as a newly opened Pi would; a session already
being worked on in Inspire since Host start keeps its position instead. Read-only viewing follows
continuations of the branch it entered on, never jumping to another branch that becomes the saved
default. A manually selected leaf is viewed the same way. Leaving and re-entering read-only viewing
selects the then-current default again.

The title menu's branch choice and History's **Switch to this branch** (offered for branch ends
while read-only) use one selection. A live Pi running the chosen branch keeps or makes the view
read-only, stopping Inspire's idle worker; otherwise the view becomes editable there, navigating the
worker or starting it at that leaf. An attached Pi is released when another branch is chosen.

### Live instances

Admission reads live [attach-control](../../docs/extensions.md#share-sessions-with-terminal-pi)
records for each decision; nothing is fenced in advance. Admission and activity badges share one
directory scan up to a second old, well inside a record's stale period; takeover, deletion and an
attached Pi's own polls read fresh records, and waiting for a Pi to exit checks only its process. A record matching session id and physical file
from a live process incarnation corresponds to the view when its leaf lies on the viewed
root-to-leaf line: an ancestor (a report may lag one append) or a continuation.

- No corresponding instance: the view is editable and Inspire's own worker starts directly. A
  worker started for a non-default view first navigates to it, so displayed conversation and model
  context agree.
- One or more: the view is read-only (`external-active`) with that Pi's progress and **Take over**.
- Unreadable or missing records are no instance; a delay between persistence and reporting never
  becomes a lasting fence. Read-only views recheck about every two seconds and become editable as
  soon as no instance corresponds.

Inspire's own workers load attach-control with their worker tag; their records are ignored while
this Host owns them. Sessions worked on in Inspire since Host start (input sent, a takeover, or a
branch chosen to continue here) keep that continuity: idle reclamation, navigation and other
processes' appends never return them to read-only viewing. A worker warmed by merely viewing a
session grants none; entering such a session again applies the rule, stopping that idle worker if a
live Pi runs the branch. A Host restart returns every session to this ordinary rule.

### Takeover

**Take over** attaches to the preferred corresponding instance: idle first, then the most recent
activity. The binding is to that process incarnation and session file; every operation re-resolves
its current endpoint, so reloads are transparent, and input and Stop stay addressed to it. The view
follows the attached Pi's reported leaf as soon as the saved projection contains it, even when
the report arrives after Inspire has already read that file revision. When the attached Pi exits,
moves to another session or off the viewed branch, or stays unreachable for longer than a reload
takes (the record's stale period), the binding ends and the view continues editable with Inspire's
own worker at its position.
Ending the attachment does not establish how a task the Pi was running turned out. The view says
why it was released (the Pi exited, opened another session, moved off the branch or stopped
responding) and claims no failure. Only an exit during work ends the task; it is reported as ended
with an unknown outcome. A Pi that is still running may continue its work, so no task notification
is sent for it.
Shorter failures keep the binding and the view editable; an action sent meanwhile fails and can be
retried. A takeover whose Pi cannot be read fails without changing the view. Pending input queued in that Pi is not observable; agent Stop does not interrupt its
terminal shell; its dialogs stay in its terminal and block browser input. A receipt means Pi accepted
the call. Host shutdown and idle reclamation leave attached Pi running.

Attached connections stay outside the owned-worker pool and are not reclaimed. Input keeps artifact
validation, file-backed images and final Stop/session fences; uncertain admission is never resent.
Actions that need Inspire's own worker (branch tools, settings that restart a worker) are
unavailable while attached.

## Extension requests

Background extension dialogs remain attached to their worker and reappear when its session is viewed.
Responses carry session and request identity. A new-session worker has a Host-only provisional
identity before startup, then atomically rebinds or unregisters. Shutdown stops and drains provisional
workers; provisional ids never leave the Host, and early questions keep their owner.
