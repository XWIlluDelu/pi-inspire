---
purpose: "Pi JSONL remains authoritative while previews, independent workers, startup reconciliation, and mutation admission retain one explicit writer boundary."
covers:
  - server/runtime*.ts
  - server/external-session.ts
  - server/pi-session-occupancy.ts
  - extensions/inspire-session-bridge.ts
  - tests/server/pi-session-occupancy*.test.ts
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
at admission. The history source must still be valid: missing or corrupt JSONL retains its own error.

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

## New-session materialization

Pi reserves a path before creating JSONL, so model, thinking, name, extension state and the first
message may exist only in the creating worker. Explicit model/thinking choices enter as startup
arguments. Until disk records them, snapshots retain the explicit thinking choice rather than the
empty projection's structural `off`; without an explicit choice, use live worker state.

Only `newSession` may open a healthy empty projection for an absent path. Read the creating worker's
bounded contiguous `get_entries` once, covering a file appearing during setup, then attest each
observed complete-line prefix against that state. Header version, session ID, cwd, root parent,
entry chain and physical append lineage must agree. Header-only and multi-write flushes keep this
transition open until disk catches up. Disk-before-event entries retain correlation and consume
their exact matching event once. Mismatch stops the worker; existing-session open treats absent
JSONL as an error. Once materialized, normal inode/version/append rules apply.

An unselected, idle, never-materialized session has no catalog identity and may be abandoned by LRU;
selected or running work retains its worker.

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
equivalence; public RPC cannot distinguish an exactly matching concurrent append after the second
baseline, so the one-writer rule remains authoritative.

A response-bearing `extension_ui_request` before RPC startup completes is unsupported. Stop and
clean the child immediately and return `PI_STARTUP_RESPONSE_UI_UNSUPPORTED`, rather than expose an
unanswerable dialog or wait for timeout. One-way startup UI remains allowed.

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
be cancelled while a later receipt is pending.

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
writer admission, Fork and explicit recovery retain their full validation. Lazy resource reads
recheck slot, view and revision before and after reconciliation.

A metadata-only observation may refresh the same worker's source version only after stable
full-byte revalidation of the same filesystem object, with healthy complete contents, no unresolved
tail or conflict, and the exact prior writer baseline still current. An owned hash prefix alone
is insufficient. This admits no entry, consumes no claim, and changes neither history revision nor
browser view. An identical-byte in-place rewrite is indistinguishable from timestamp-only movement
and is treated as unchanged state, not attributed to a writer. Startup source-version checks and
incomplete-tail continuation rules, including bounded new-file materialization, remain unchanged.

### Conflicts and uncertain writes

Duplicate identities, missing/forward parents, content or incomplete-tail rewrites, unmatched custom
entries, replacements even with identical bytes, and worker/disk delta mismatches retain the last-good
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
input are never reclaimed. Detail subscriptions retain views under [[session-transport]].

## Native external-session admission

### Ownership evidence

Every saved-file cold writer admission discovers native ownership inside the mutation gate,
including writer-backed actions without selection warmup. Supported Herdr control stays on the
original process; [[herdr-enhancement]] owns that public API integration.

When discovery supplies no controllable connection, check optional local Pi presence before process
creation and again immediately before startup. A report matching native session identity and
physical file from a live process incarnation fences all cold writer-backed actions, including
settings, as `external-active`. Activity and heartbeat age do not release the fence.

Retain known presence through missing, malformed or unreadable reports. Release it only after a
completed producer rebind or confirmed process retirement, including birth mismatch after PID reuse.
Linux birth evidence includes boot identity; metadata-query failure is not retirement. Legacy
reports without birth evidence remain fenced while their PID exists.

Neither activity-stop hints nor legacy `released` flags prove retirement: Pi emits `session_shutdown`
before remaining handlers and disposal finish. Quit stays fenced until process retirement. Native
new/resume/fork transfers a report only when fresh `session_start` metadata uniquely matches the
outgoing reason, source and target files. Same-file replacement and ambiguous/failed transfers stay
held; Reload preserves presence. An SDK host that disposes a session but keeps its process alive
has no reporter-visible post-disposal drain signal, so the fence lasts until retirement or a
confirmed native rebind.

Retained presence survives Host replacement even if the source report disappears temporarily.
Completed rebinds and retirement update it; manually deleting the entire presence cache removes
that evidence. Within a Host, observations and retained-evidence updates share a FIFO so older
cache commits cannot overwrite newer bindings.

Activity and presence neither grant control nor form a writer lease. They observe cooperating
runtimes using the enabled extension or Herdr; process names cannot establish participation.
Pre-start checks are not an atomic reservation against an uncoordinated simultaneous external launch.
New owned sessions retain their ordinary lifecycle.

### Recovery and native control

Discovery or observation failure preserves readable history and fences execution as
`external-unavailable`. Connection loss alone does not prove release; `read() === null` requires
confirmation that the owner no longer writes this session.

External read-only sessions with browser detail subscriptions share automatic availability checks.
The last subscriber leaving stops recovery observation; established native connections keep their
owner polling. Recovery uses ordinary discovery, occupancy and mutation-gate admission, including
any other holder. Clear read-only state only when native control reconnects or the local writer
completes startup, not when an occupancy check passes.

Observation and pre-start preparation failures remain retryable. Deletion reservations pause
attempts. Once Pi startup begins, startup/attestation failure requires explicit retry so the loop
cannot repeat extension startup hooks. A view abandoned during discovery stays read-only;
resubscription resumes observation. Unchanged observations do not repeatedly refresh the page,
and manual reselection requests an immediate check.

Recovery preserves the transcript view, reading position, unsent draft and attachments. Pre-start
cleanup alone preserves the view; history replacement invalidates it. A pre-start read-only refusal
is not a failed Pi run. Recovery neither selects a session nor replays input or bypasses attestation.
Explicit terminal handoff and missing-workspace states keep their own continuation rules.

Native connections stay outside the owned-worker pool. Host shutdown detaches them and drains
admitted deliveries without terminating external Pi. Input retains artifact validation, file-backed
images and final Stop/session fences. Unsupported operations stay in the terminal, and uncertain
admission is never automatically resent.

## Extension requests

Background extension dialogs remain attached to their worker and reappear when its session is viewed.
Responses carry session and request identity. A new-session worker has a Host-only provisional
identity before startup, then atomically rebinds or unregisters. Shutdown stops and drains provisional
workers; provisional ids never leave the Host, and early questions retain their owner.
