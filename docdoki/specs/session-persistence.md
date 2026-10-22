---
purpose: "Pi JSONL remains authoritative while previews, independent workers, startup reconciliation, and mutation admission retain one explicit writer boundary."
covers:
  - server/runtime*.ts
  - server/external-session.ts
  - server/pi-session-occupancy.ts
  - docs/examples/session-activity.ts
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

- Opening an unopened session first projects its active branch through Pi’s read-only parser and
  context builder, without waiting for extensions or writing the JSONL; transcript virtualization
  avoids mounting every entry in a large history at once. Upload-retention and project-discovery
  registry writes are not prerequisites for this preview. Observed session directories enter
  in-memory retention discovery; GC must register them before it can reclaim uploads. Cold writer
  admission still requires durable registration and reports its own failure without discarding
  readable history.

- History readability does not depend on the original project directory. If that directory is
  missing, is not a directory, or cannot be resolved, a valid retained JSONL still opens through the
  same projection and resource authority. The snapshot reports `readOnlyReason: workspace-unavailable`;
  neither a Pi worker nor project model discovery starts. Worker-backed mutations and independent
  Fork/Clone reject at admission. Missing or corrupt session files retain their existing errors:
  an unavailable workspace does not excuse an invalid history source.

- For an available project directory, the independent Pi worker warms outside the selection critical
  path, and its `runtime_ready` event replaces the temporary preview with authoritative RPC state only
  if that session is still selected. Readiness requires the startup attestation below.

- Explicitly reopening a workspace-unavailable session rechecks its recorded directory. If restored,
  resolve and retain its physical root, renew the resource view, and use ordinary startup attestation
  before execution. Do not create the missing directory, substitute the Host cwd, or change the
  session header to make a history view executable.

## New-session materialization

Pi reserves a session path before creating JSONL, so model, thinking, name, extension state and the
first user message may exist only in the creating worker. Explicit model/thinking choices enter as
startup arguments. Until corresponding disk changes exist, the explicit thinking choice remains
visible in returned/later snapshots rather than yielding to a projection's structural `off`; without
an explicit choice, use live worker state.

Only `newSession` may open a healthy empty projection for an absent path. Read the creating worker's
bounded contiguous `get_entries` once, covering a file appearing during setup, then attest each
observed complete-line prefix against that state. Header version, session ID, cwd, root parent, entry
chain and physical append lineage must agree. Header-only and multi-write flushes keep this one
transition open until disk catches up. Disk-before-event entries retain persistence correlation and
consume their exact matching event once. Mismatch stops the worker; ordinary existing-session open
treats missing JSONL as an error. Once materialized, normal inode/version/append rules apply.
An unselected idle never-materialized session has no catalog identity and may be abandoned by LRU;
selected/running work retains its worker.

## Startup trust boundary

- Worker startup establishes a trusted projection tail (or trusted empty baseline), constructs the
  process, then immediately reconciles again before `rpc.start()` and requires identity/stat
  version, revision, tail, fingerprint, and committed bytes to be unchanged. Projection readers
  remain serialized behind the boundary. A response-bearing `extension_ui_request` observed before
  Pi RPC startup completes is an unsupported `session_start` boundary: the host stops and cleans
  that child immediately and returns the attributable `PI_STARTUP_RESPONSE_UI_UNSUPPORTED` error
  instead of exposing an unanswerable dialog or waiting for timeout; one-way startup UI remains
  allowed.

  After start, Pi and its extensions may persist native session entries. The delta must be a
  complete, direct, contiguous append within the existing RPC transport limit, without a separate
  startup size/count cap or entry-type whitelist. `get_entries`, `get_state`, and disk must agree
  on every persisted entry, parent, final leaf, session, path, thinking level, and append lineage
  before the writer baseline advances.
  After the final filesystem observation, the same worker must still own the slot and remain RPC
  available before readiness is published or the writer baseline advances. A retired worker cannot
  reset failure to idle or emit `runtime_ready`.
  This establishes state equivalence, not causal authorship: stock public RPC cannot distinguish an
  exactly matching entry from a prohibited concurrent writer in the interval after the second
  baseline. The one-writer rule remains authoritative. RPC/disk disagreement, wrong parents or
  values, path/session mismatch, filesystem-object change, incomplete entries, and rewrites stop
  the worker; legitimate extension persistence is not evidence of an external writer.

- After an RPC mutation frame is written, stream failure or child loss leaves acceptance unknown.
  Confirm worker termination, reconcile disk inside the operation lane and retain a conflict rather
  than retrying or restaging its input. An observer timeout alone proves neither failure nor exit.

- A reconciliation conflict is sticky across `agent_settled` and other terminal lifecycle events:
  the worker remains stopped until the explicit recovery boundary clears the conflict, and no
  terminal event may silently reauthorize it.

## Writer admission and resource ownership

- Each selected or active session owns an independent Pi runtime, and selecting another conversation
  changes only the browser projection; background runs continue without interruption. Before a
  worker starts, the host resolves the selected workspace to one physical directory and stores that
  immutable root in the slot; project-file resolution, attachment context, resource access, and Git
  inspection all use that slot-owned root, so later symlink retargeting cannot split host operations
  from Pi. The browser does not parse or register a second workspace path. The writer baseline
  includes exact file identity/source version and observed physical bytes.

  Every Pi `message_end`, `compaction_end`, and `entry_appended` persistence event enters the same
  expectation ledger; each claimed entry is matched byte-for-byte rather than accepted by id or
  payload type alone. If filesystem reconciliation observes a complete append before
  `entry_appended` arrives, the host requests the owning worker's bounded `get_entries` delta from
  its trusted leaf and accepts only when every observed appended entry is an exact persisted-JSON
  prefix of that contiguous worker chain.

  Explicit reconciliation, filesystem/poll hints, and watch-health observations share one FIFO
  through reading, asynchronous ownership verification, and writer-baseline commit. Queueing only
  reads or only their subsequent handlers is insufficient. Hints coalesce while a consumer is
  pending; a retired projection or worker cannot commit a late witness or deferred receipt.
  Startup attestation retains its separate suspended-reader boundary.

  The live worker may already have advanced beyond the older disk snapshot, but its worker-only
  suffix is not accepted until a later disk reconciliation observes and proves it; matching
  persistence expectations that arrive during witness lookup are consumed only through the observed
  prefix, while later claims remain queued. Matched claims retire by identity, not by a count of
  current queue heads: an earlier claim may be cancelled while a later receipt is still pending.
  Owned partial persistence preserves exact prefix/tail continuity and requires exact final entry
  provenance. Elapsed observation time is not evidence of corruption and never stops the writer.
  Until the write completes, retain the last complete history and report persistence as pending;
  operations that require complete persistence wait or refuse without restarting the worker.
  Direct native Bash can hold this pending state while its owning worker remains current, even
  with an idle run state and no persistence event; the final entry still requires the ordinary
  exact worker/claim witness. While the sole worker has an exact pending
  append claim, the projection extends its verified SHA-256 state and immutable normalized
  entry/message prefix; without that provenance it rereads and verifies the committed bytes before
  parsing a suffix.

  Ordinary snapshots, history pages, and lazy resource-message reads may reuse a healthy verified
  projection only after a fresh non-following check of the same regular file's device, inode, size,
  modification time, and change time. Changed or unhealthy sources still undergo byte validation
  in the same observation FIFO. This avoids rehashing an unchanged history on every page without
  weakening forced startup, writer admission, fork, or explicit recovery validation. Lazy resource
  reads still recheck their slot, view, and revision on both sides of reconciliation.

  A metadata-only observation may refresh the same worker's source version after a stable full-byte
  revalidation of the same filesystem object, with healthy complete contents, no unresolved tail,
  no conflict, and the exact prior writer baseline still current. Reusing an owned hash prefix is
  not this proof. The observation admits no entry, consumes no append claim, and changes neither
  the history revision nor the browser view. A completed in-place identical-byte rewrite is
  indistinguishable from timestamp-only movement under this evidence and is treated as unchanged
  state, not attributed to a writer. This exception does not relax startup source-version checks
  or incomplete-tail continuation rules, including their existing bounded new-file boundary.

  Duplicate identities, missing or forward parents, content rewrites, incomplete-tail rewrites,
  unmatched custom entries, replacements (even with identical bytes), and worker/disk delta
  mismatches retain the last-good projection and fail closed.
  Unselected idle workers form a three-entry LRU warm cache and transparently restart from Pi’s
  session file after reclamation; busy workers, accepted prompts awaiting their lifecycle event,
  in-flight host operations, and workers awaiting or consuming extension input are never reclaimed.
  Reclamation drops the reloadable transcript projection as well as the child process.

- inspire never starts a second AgentSession worker for a session it already owns and does not
  modify that source JSONL while its Pi runtime owns it; the fork helper operates only on a private
  verified snapshot and a new destination identity. `RuntimeController` remains the registry,
  selection, mutation-gate, and command facade; bounded collaborators own slot construction,
  process-to-slot identity, startup attestation, worker lifecycle, LRU reclamation, and projection
  reconciliation through its narrow callbacks. None stores a parallel session catalog, projection
  authority, or persistence lane.

## Native external-session admission

- Every saved-file cold writer admission checks the existing native-session discovery boundary
  inside the mutation gate, including writer-backed actions without selection warmup. Herdr
  supplies this connection through its public native agent API; [[herdr-enhancement]] owns it.
- If native discovery supplies no controllable connection, check the optional local Pi presence
  reports before creating a worker and recheck immediately before Pi startup. A report matching
  native session identity and physical file, from a still-live process incarnation, keeps history
  read-only as `external-active` and vetoes all cold writer-backed actions, including settings.
  Activity (`idle`, `working`, `blocked`) and heartbeat age do not release this fence.
  Existing supported Herdr control stays on its original process rather than starting a local writer.
- Retain known presence through missing, malformed or unreadable reports. Release only on a
  completed producer rebind or confirmed process retirement, including birth mismatch after PID reuse.
  Neither an activity-stop hint nor the legacy `released` flag proves writer retirement: Pi emits
  `session_shutdown` before remaining shutdown handlers and disposal have finished. Quit stays fenced
  until process retirement. Native new/resume/fork transfers the same report only when a fresh
  `session_start` uniquely matches the outgoing reason, source file and target file; same-file
  replacement stays held, while ambiguous/failed transfers retain prior evidence.
  Linux birth evidence includes the boot identity. A failed metadata query is not retirement.
  Legacy activity-only records without birth evidence are treated conservatively while their PID
  exists. Reload preserves presence; it is not a teardown of the writer.
- Discovery/observation failure retains readable history and fences execution as
  `external-unavailable`. Connection loss alone never proves writer retirement. `read() === null`
  requires confirmation that the owner no longer writes this session.
- External read-only sessions with active browser detail subscriptions automatically recheck
  availability. Browsers viewing the same session share one check; the last subscription leaving
  stops recovery observation. Established native connections keep their existing owner polling.
  After confirmed release, ordinary discovery, occupancy checks and the slot's writer-admission
  gate govern continuation, including any other holder. Successful recovery clears the read-only
  boundary when native control reconnects or the local writer completes startup, not when an
  occupancy check passes. Observation and pre-start preparation failures remain retryable; a
  deletion reservation pauses attempts rather than ending recovery. Once Pi has started, a failure
  uses ordinary startup-error handling instead of automatically restarting `session_start` hooks.
  A view abandoned during discovery stays read-only, and resubscribing resumes observation.
  Unchanged observations do not repeatedly refresh the page. Manual reselection remains an
  immediate check, not a prerequisite for recovery.
- Recovery updates the current session in place, preserving its transcript view, reading position,
  unsent draft and attachments. Pre-start cleanup alone preserves the reading view; history
  replacement still invalidates it. A pre-start read-only refusal is not a failed Pi run.
  Recovery does not select a session, replay input or bypass startup attestation. Explicit
  terminal handoff and missing-workspace read-only states keep their own continuation rules.
- Native connections remain outside the owned-worker pool. Host shutdown detaches them and
  drains admitted delivery operations without terminating the external process. Input retains
  artifact validation, file-backed image references and final Stop/session fences. Unsupported
  operations go to the original terminal rather than another writer. Uncertain admission is
  never automatically resent.
- Neither activity nor presence is a controller or a writer lease. The enabled Pi extension and
  Herdr provide cooperating-process evidence; runtimes that never loaded either cannot be inferred
  from a process name. These pre-start checks are not an atomic cross-application reservation
  against a simultaneous, uncoordinated external launch. New owned sessions retain their existing
  lifecycle. Positive admission evidence is retained privately across Host replacement, even if
  its source report temporarily disappears. Completed rebinds and confirmed retirement update it;
  deleting the whole presence cache manually removes this evidence. An SDK host that disposes one
  session but keeps its process alive has no reporter-visible post-disposal persistence-drain signal;
  that session remains conservatively fenced until process retirement or a confirmed native rebind.
  Within one Host, admission observations and retained-evidence updates share a FIFO so an older
  cache commit cannot overwrite a newer completed binding during concurrent opens.

## Extension requests and dependency boundaries

- A dialog request raised by a background extension remains attached to its owning worker and is
  restored when that session is viewed; responses carry both session and request identity so
  concurrent navigation cannot misroute or orphan required input.

  A new-session worker is registered under a host-only provisional identity before startup begins,
  then atomically rebound or unregistered; shutdown stops and drains provisional workers before
  returning and provisional ids never leave the host, so early extension questions stay answerable
  without escaping lifecycle ownership.

- Runtime construction accepts an explicit `SessionProjectionView` opener for read-only projection
  I/O. Workspace canonicalization, pre-write reconciliation, and startup/persistence admission do
  not identify or special-case test functions or concrete projection classes. Hidden-clear
  filesystem preflight likewise defaults to the real validator independently of the injected
  deletion adapter; substituting destructive delivery never silently disables identity validation.
  Scheduling substitutes live in tests; persistence and workspace guarantees use real temporary
  filesystem fixtures.
