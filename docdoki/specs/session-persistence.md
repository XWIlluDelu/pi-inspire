---
purpose: "Pi JSONL remains authoritative while previews, independent workers, startup reconciliation, and shared use with other Pi processes keep each view on its own branch."
covers:
  - server/runtime*.ts
  - server/external-session.ts
  - server/attach-control.ts
  - extensions/inspire-session-bridge.ts
  - server/pi-rpc.ts
  - server/session-{projection,jsonl,metadata,tree,document-worker,search,search-worker,fork,fork-worker}.ts
  - server/persisted-json.ts
  - server/resources.ts
  - tests/server/runtime*.test.ts
  - tests/server/session-projection*.test.ts
  - scripts/benchmark-projection-reads.mjs
  - tests/server/pi-{rpc,compat.integration,startup.integration}.test.ts
---

# Session persistence and worker ownership

## Goal

Continue sessions without copying their durable state or weakening the filesystem and worker trust
boundary. Catalog and navigation obligations remain in [[session-continuity]]; branch actions are in
[[session-branches]].

## Read-only preview and independent workers

Catalog summaries, full-history search, and transcript projections share a document reader. It
opens regular files without following the final symlink, checks the observed file version and
address, and scans complete UTF-8 JSONL frames with one header check. An incomplete last frame stays
outside the committed prefix until its newline arrives. Catalog summaries keep bounded metadata and
can extend a cached summary from the last complete frame. Full projections verify byte prefixes,
migrate old Pi entries in memory, and share the native entry index with History. A full scan after
a prefix mismatch uses the same open file. Search still runs off-thread.

Opening a session reads its saved entries and projects the active branch with Pi's context
builder, without writing JSONL or waiting for extensions. The Live tail and native History page each
bound the mounted rows. Auxiliary project-discovery writes and upload-retention registration are not prerequisites
for history reads or writer admission.

Valid retained history remains readable when its project directory is missing, is not a directory,
or cannot be resolved. The snapshot reports `readOnlyReason: workspace-unavailable`; neither a Pi
worker nor project model discovery starts. Worker-backed mutations and independent Fork/Clone reject
at admission. The history source must still be valid: missing or corrupt JSONL keeps its own error.

For an available project, ordinary open and reconnect read saved history and observe existing
ownership. They do not launch a Pi. Sending a prompt or invoking a worker-backed operation admits
the writer on demand. `runtime_ready` publishes authoritative RPC state after startup attestation.
Reopening a workspace-unavailable session rechecks its recorded directory. If restored, retain its
resolved physical root and renew the resource view. Do not create the directory, substitute the Host
cwd, or rewrite the session header to make history executable.

Each selected or active session has an independent runtime; switching conversations leaves
background work running. Worker events belong to the slot's current Pi process, and retiring the
process removes its subscriptions. New sessions finalize the same provisional slot. Before startup,
resolve one immutable physical workspace root for Pi,
project files, attachment context, resources and Git inspection. Later symlink retargeting must not
split those operations across roots, and the browser does not register a second workspace path.

A running owned worker supplies its native leaf and finalized entries. The saved document
supplies disk health and saved routes; its latest physical append does not choose the worker's
branch. Attached Pi instances keep their own lifetime and capabilities.

## New-session materialization

Pi reserves a path before creating JSONL, so model, thinking, name, extension state and the first
message may exist only in the creating worker. Explicit model/thinking choices enter as startup
arguments. Until disk records them, snapshots keep the explicit thinking choice instead of the
empty projection's structural `off`; without an explicit choice, use live worker state.

Only `newSession` may open a healthy empty projection for an absent path. Read the creating worker's
bounded contiguous `get_entries` once, covering a file appearing during setup, then attest each
observed complete-line prefix against that state. Header version, session ID, cwd, root parent,
entry chain and physical append lineage must agree. Header-only and multi-write flushes keep this
transition open until disk catches up. The live presentation remains under native checkpoint
control throughout materialization. Mismatch stops the worker; existing-session open treats absent
JSONL as an error. Once materialized, normal inode/version/append rules apply.

An unselected, idle, never-materialized session has no catalog identity and may be abandoned by LRU;
selected or running work keeps its worker.

## Startup trust boundary

Capture a trusted projection tail or empty baseline before constructing the process. Immediately
before `rpc.start()`, reconcile again and require unchanged file identity/stat version, revision,
tail, fingerprint and committed bytes. Projection readers remain serialized behind this boundary.

At startup the bridge reports a digest of the previously admitted number of normalized native
entries, before later extension hooks can change that context. Pi may have added its own missing
settings; compare those with the post-start suffix instead of the old prefix.

After start, Pi and its extensions may persist entries. `get_entries` provides the worker
continuation and actual leaf within the RPC transport limit. Its parent chain must extend the
admitted prefix and its entries must be present in the intact saved file. `get_state` confirms
the session and path. The file can also contain valid independent appends, which advance its
saved leaf without changing the worker's branch. Incomplete frames, source replacement and
prefix rewrites fence admission.

After the final filesystem observation, the same worker must still own the slot and remain
RPC-available before readiness and its native index are published.

A response-bearing `extension_ui_request` before RPC startup completes is unsupported. Stop and
clean the child immediately and return `PI_STARTUP_RESPONSE_UI_UNSUPPORTED` instead of exposing an
unanswerable dialog or waiting for timeout. One-way startup UI remains allowed.

## Saved-file integrity and native checkpoints

The saved document checks identity, committed bytes, UTF-8/JSONL framing and unfinished tails.
Structurally valid appends extending the verified prefix are accepted regardless of which Pi
wrote them. While an unresolved tail exists, Host writer admission fails. Completing that same
tail preserves the existing file generation; replacing or truncating it retires an owned worker.
Source replacement invalidates saved cursors even when bytes are unchanged.

The Host bridge reads the public session manager at turn start, before a model call and at
agent settlement. Its checkpoint
names the worker, native context generation, session, previous cursor, last entry and actual leaf.
Ordered bounded frames carry only the new native entries. A completed batch updates the worker
index, after confirming that it continues the admitted cursor. Idle custom messages, commands,
Bash, compaction and file changes can request a coalesced native checkpoint. An in-progress
checkpoint can extend the native cursor. The visible leaf advances only when its seal can replace
the matching live rows in the same publication.
The disk reader and worker checkpoint use the same native entry indexing and query code.
Their source versions and leaves advance independently. A replaced or rewritten saved source
retires the old history cursor generation and invalidates composer recall from that source.

At a sealed boundary, compare ordered occurrences in that native suffix. Saved rows use native
entry IDs; transient rows keep their own stream identity. Matching the same content twice requires
two native occurrences. If Pi cannot confirm a finished row, Live retains it as unconfirmed.
A native Bash result may be deferred beyond the agent boundary and stays independently visible
until its own result is checkpointed. No complete disk append is used to claim a live event.

### Conflicts and uncertain writes

Duplicate identities, missing/forward parents, content or incomplete-tail rewrites, replacements
even with identical bytes, and overwritten partial lines keep the last-good
projection and block writing.

After an RPC mutation frame is written, stream failure or child loss leaves acceptance unknown.
Confirm termination, reconcile disk in the operation lane and retain a conflict; do not retry or
restage the input. An observer timeout proves neither failure nor exit. Conflicts survive
`agent_settled` and other terminal events until explicit recovery clears them.

## Worker lifetime and runtime boundaries

Inspire never starts a second worker for a session it owns or modifies source JSONL while that
runtime owns it. The fork helper uses only a private verified snapshot and a new destination.
Saved search and branch copying run in bounded threads. The Host joins the copy thread's exit
before releasing its staging directory.
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
worker if already running, or retaining that leaf for the first worker-backed action. An attached Pi is released when another branch is chosen.

### Live instances

Admission reads live [attach-control](../../docs/extensions.md#share-sessions-with-terminal-pi)
records for each decision. Activity badges can reuse recent observations. Cold writer admission,
restored browser views, branch selection, takeover and deletion check current process identity.
Waiting for a Pi to exit checks its process. A live instance of the same session file owns a
view when its leaf is at or beyond the viewed position on that branch. An older reported leaf
triggers a live check because the record can lag an append. If the check confirms that Pi is
still at the older node, Inspire can start its own worker for the viewed branch.

- No corresponding instance: the view is editable. When an action first needs a writer, a worker
  started for a non-default view navigates to it before executing that action.
- Opening a session or reconnecting a browser view attaches automatically when exactly one Pi
  could own the branch, its control endpoint is available, and live state confirms it is idle.
  Otherwise the view is read-only (`external-active`) with progress and **Take over**.
- A stale heartbeat from a process that is still alive leaves its branch unknown. An unavailable
  live check or a reported leaf still missing from the refreshed projection
  blocks cold writer admission. Read-only views recheck about every two seconds.

Inspire's own workers load attach-control with a tag bound to the worker launcher. The owning Host
excludes those records from external admission. Sessions worked on in Inspire keep their viewed
position across idle reclamation and navigation. Starting a replacement worker checks live
ownership again, including after an attachment ends or the browser restores an addressed view.
An addressed browser reconnect restores the view and checks for an external Pi without selecting
the session for other browsers or starting a worker.

### Takeover

**Take over** prefers a Pi whose reported leaf is at or beyond the viewed position on the same
branch. An ancestor or unprojected leaf can prompt a live check when there is no reported
continuation. An available endpoint must confirm a continuation before attaching. Several
equally plausible endpoints require the user to resolve the conflict and retry. The binding names
the process incarnation and session file. Each operation opens its own socket at the current
endpoint, keeping input and Stop addressed to the same Pi across reloads. The view
follows the attached Pi's reported leaf as soon as the saved projection contains it, even when
the report arrives after Inspire has already read that file revision. When the attached Pi exits,
moves to another session or off the viewed branch, or stays unreachable for longer than a reload
takes (the record's stale period), the binding ends. Inspire can start its own worker at the viewed
position once a fresh scan finds no owner for it.
Ending the attachment does not establish how a task the Pi was running turned out. The view says
why it was released (the Pi exited, opened another session, moved off the branch or stopped
responding) and claims no failure. Only an exit during work ends the task; it is reported as ended
with an unknown outcome. A Pi that is still running may continue its work, so no task notification
is sent for it.
Shorter failures keep the binding and the view editable. If a Pi still owns the branch but its
endpoint is unavailable, takeover leaves the view read-only. Pending input queued in that Pi stays
invisible to Inspire. Agent Stop targets that Pi's agent work, and its terminal dialogs block
browser input. Host shutdown and idle reclamation leave attached Pi running.

Attached connections stay outside the owned-worker pool. Input keeps artifact validation,
file-backed images and final Stop/session fences. The browser identifies the branch view it sent
from. A changed branch blocks delivery. Stop and its preliminary Pending recovery share the view
selected at the click. Input, rename, model and thinking changes stay addressed
to the attachment present when the request begins.
An SDK-hosted native terminal (`inspire pi`) confirms Steer and Follow up using Pi's per-input
return value, independently of the next turn. A regular terminal Pi exposes no such result
through its extension interface; busy remote input is refused before submission and its local
queue remains under its terminal's control.
A missing admission witness or lost reply after dispatch leaves the outcome unknown, and retrying
the same browser operation observes the original receipt. Shell and Pi slash commands run from the
attached Pi's own interface. Branch tools and settings that restart a worker require an
Inspire-owned worker.

## Extension requests

Background extension dialogs remain attached to their worker and reappear when its session is viewed.
Responses carry session and request identity. A new-session worker has a Host-only provisional
identity before startup, then atomically rebinds or unregisters. Shutdown stops and drains provisional
workers; provisional ids never leave the Host, and early questions keep their owner.
