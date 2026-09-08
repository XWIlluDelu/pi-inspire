---
purpose: "Pi JSONL remains authoritative while previews, independent workers, startup reconciliation, and mutation admission retain one explicit writer boundary."
covers:
  - server/runtime*.ts
  - server/pi-rpc.ts
  - server/session-{projection,preview,jsonl}.ts
  - server/persisted-json.ts
  - server/resources.ts
  - tests/server/runtime*.test.ts
  - tests/server/session-{projection,preview,jsonl}.test.ts
  - tests/server/pi-{rpc,compat.integration}.test.ts
---

# Session persistence and worker ownership

## Goal

Continue sessions without copying their durable state or weakening the filesystem and worker trust
boundary. Catalog and navigation obligations remain in [[session-continuity]]; branch actions are in
[[session-branches]].

## Checks

### Read-only preview and independent workers

- Opening an unopened session first projects its active branch through Pi’s read-only parser and
  context builder, without waiting for extensions or writing the JSONL; transcript virtualization
  avoids mounting every entry in a large history at once.

- The independent Pi worker warms outside the selection critical path, and its `runtime_ready` event
  replaces the temporary preview with authoritative RPC state only if that session is still selected.
  Readiness requires the startup attestation below.

### Startup trust boundary

- Worker startup establishes a trusted projection tail (or trusted empty baseline), constructs the
  process, then immediately reconciles again before `rpc.start()` and requires identity/stat
  version, revision, tail, fingerprint, and committed bytes to be unchanged. Projection readers
  remain serialized behind the boundary. A response-bearing `extension_ui_request` observed before
  Pi RPC startup completes is an unsupported `session_start` boundary: the host stops and cleans
  that child immediately and returns the attributable `PI_STARTUP_RESPONSE_UI_UNSUPPORTED` error
  instead of exposing an unanswerable dialog or waiting for timeout; one-way startup UI remains
  allowed.

  After start, the only accepted delta is one strictly bounded, direct, contiguous append composed
  of installed-extension non-transcript `custom` state plus at most one missing
  `thinking_level_change`; `get_entries`, `get_state`, and disk must agree byte-for-byte on every entry, parent,
  final leaf, session, path, thinking level, and append lineage before the writer baseline advances.
  This establishes state equivalence, not causal authorship: stock public RPC cannot distinguish an
  exactly matching entry from a prohibited concurrent writer in the interval after the second
  baseline. The one-writer rule remains authoritative, and messages, model changes, compactions,
  unsupported or oversized mixed deltas, wrong parents or values, path/session mismatch,
  filesystem-object change, and rewrites stop the worker.

- A reconciliation conflict is sticky across `agent_settled` and other terminal lifecycle events:
  the worker remains stopped until the explicit recovery boundary clears the conflict, and no
  terminal event may silently reauthorize it.

### Writer admission and resource ownership

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

  The live worker may already have advanced beyond the older disk snapshot, but its worker-only
  suffix is not accepted until a later disk reconciliation observes and proves it; matching
  persistence expectations that arrive during witness lookup are consumed only through the observed
  prefix, while later claims remain queued. Owned partial persistence must advance that same lineage
  by strictly growing bytes with exact prefix/tail continuity. While the sole worker has an exact
  pending append claim, the projection extends its verified SHA-256 state and immutable normalized
  entry/message prefix; without that provenance it rereads and verifies the committed bytes before
  parsing a suffix.

  Duplicate identities, missing or forward parents, same-byte rewrites, unmatched custom entries,
  replacements, and worker/disk delta mismatches retain the last-good projection and fail closed.
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

### Extension requests and dependency boundaries

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
