---
purpose: "Pi owns branch semantics while same-file navigation and isolated fork creation retain explicit revision, writer, and publication boundaries."
covers:
  - server/runtime.ts
  - server/runtime-branch*.ts
  - server/session-{tree,fork,fork-worker}.ts
  - server/extensions/inspire-branch-bridge.ts
  - src/controllers/branch-controller.ts
  - src/components/{BranchTree,EarlierBranchBanner}.tsx
  - tests/server/{runtime-branching,session-fork,session-tree,branch-bridge-extension}.test.ts
  - tests/web/{branch-tree,branch-store}.test.ts*
---

# Session branches and independent forks

## Goal

Inspect, navigate, edit from, and fork Pi trees without replacing an active source worker or
inventing alternate branch history. Durable trust comes from [[session-persistence]]; browser
continuity comes from [[session-transport]].

## Checks

### Pi-authoritative tree actions

- New sessions, naming, switching, compaction, and same-file branch navigation use Pi’s supported
  runtime operations; fork uses Pi's supported `SessionManager` branch semantics through the
  isolated boundary below. Pi reserves and reports a new session path immediately but deliberately
  does not create the JSONL until an assistant message exists; model, thinking, name, extension
  state, and the first user message can therefore remain only in the creating worker meanwhile. An
  explicit new-session model and thinking choice enters as Pi startup arguments.

  Until a corresponding JSONL change exists, the explicit startup thinking choice remains visible
  across returned and later worker snapshots rather than yielding to the pending projection's
  structural `off` default; a session without an explicit choice takes the live worker state
  instead. Only `newSession` may open a healthy empty projection for that absent path. The host
  reads the creating worker’s bounded contiguous `get_entries` state once to cover a file appearing
  during setup, then attests each complete-line prefix observed while the first file materializes;
  the parsed disk entries must be the worker state’s exact prefix and the current Pi header version,
  session id, cwd, root parent, entry chain, and physical append lineage must agree.

  Header-only and multi-write first flushes keep this single materialization transition open until
  disk catches the attested worker state. This verification does not depend on whether stdout
  message events or the filesystem notification arrives first: entries absorbed from disk before
  their event arrives are indexed by persistence correlation, matched by exact persisted payload,
  and consumed once. A mismatched first file fails closed and stops the worker; an ordinary
  existing-session open still treats a missing JSONL as an error. An unselected idle session that
  never materialized has no catalog identity to resume and may be abandoned by the existing worker
  LRU, while selected or running work retains its worker. Once materialized, the normal
  inode/version/append rules apply without exception.

  Once an RPC request frame has been written, stream failure or child loss is an explicit
  acceptance-unknown outcome: after confirmed worker termination, disk is reconciled inside the
  operation lane and the session remains conflicted rather than retrying or restaging attachments.
  A local observation timeout alone neither proves failure nor authorizes termination; Pi-owned
  branch hooks and summaries have no generic wall-clock allowance (see [[pi-integration]]). The
  branch tree is a bounded projection of Pi entry identities; switching creates a non-evictable
  in-memory navigation lease until the next append durably commits that branch, while edit-from-here
  moves to the selected user turn's parent and prefills the composer without submitting.

- Same-file branch navigation requires an idle, fresh, conflict-free worker with no queued input or
  pre-existing dialog. Fork requires a fresh selected source revision, materialized current-format
  source, conflict-free projection, and active-path user target; source run state, Pending queues,
  and extension dialogs are not preconditions because no source command or replacement occurs.
  Browser branch-tree and branch-action requests are owned by a bounded `BranchController`; its
  current API, transport generation, selection generation, selection intent, transcript view, and
  effective leaf must all still match before it can commit a response through `AppStore`. A
  bootstrap or selection replacement invalidates pending tree/action requests and clears their
  actionable presentation.

  Extension responses use a separate process-instance-validated per-slot FIFO, so navigation hooks
  can await browser input without deadlocking the mutation FIFO and each accepted response is
  delivered exactly once. Stale revisions and ambiguous navigation bridge outcomes fail closed; an
  unverified navigation stops the worker and reconciles disk instead of retrying.

### Same-file bridge

- Same-file navigation remains on stock Pi RPC through one inspire-owned explicit extension. Each
  worker receives randomized command, status-key, and worker identities; the host accepts only one
  bounded nonce-correlated `setStatus` result, awaits both that result and prompt completion, and
  independently verifies the post-operation leaf and absence of persisted deltas. The internal
  command is hidden from completion and rejected at the public prompt boundary. The registered
  handler's RPC completion fences result delivery: completion without its matching result is a
  protocol failure, not a reason to wait indefinitely. Missing, duplicate, malformed, stale, or
  mismatched results are never retried after possible side effects.

### Independent fork publication

- Fork is independent creation, not source-runtime replacement. The host captures a fresh
  conflict-free committed projection and selected active-path user entry, then a bounded one-shot
  process copies and verifies exactly that complete JSONL prefix into a private same-directory
  container. The process opens only the snapshot with the installed Pi SDK's `SessionManager`; it
  constructs no AgentSession or resource loader and never sends a command to, pauses, aborts,
  rebinds, or writes through the source worker. Source models, tools, extensions, queues, dialogs,
  and active work continue unchanged. Pi determines the ancestor path, labels, metadata,
  and generated destination identity. The selected user message stays excluded and becomes the
  returned Composer draft.

  The helper canonicalizes the real source path as parent provenance and materializes header-only or
  otherwise deferred no-assistant output. Source appends and partial trailing writes beyond the
  admitted prefix may continue throughout fork without entering the destination. The host opens the
  private projection, reserves its id and final path, atomically publishes the complete JSONL
  without replacement, reopens it under that reservation, and attaches a processless destination
  before normal configured worker warm-up. Concurrent open/create/delete operations share that
  reservation. Catalog-driven opens wait on the reservation, a newer
  selection intent wins, pre-publication failure removes staging, and post-publication failure
  identifies the committed destination instead of inviting a blind retry.

  Branch switching remains reversible and non-destructive; edit-from-here confirms only when it
  would replace a non-empty Composer draft.

### Earlier-branch presentation

- When the current view is a leased earlier branch, the center conversation surface projects a
  persistent `Viewing an earlier branch` notice above the transcript with explicit return-to-latest
  and fork-from-current-view actions, independent of whether the History pane is open. Each action
  refreshes the runtime-owned branch projection before acting; the notice is derived from the
  runtime-owned durable/effective leaf pair and does not introduce browser branch authority.

  The mock-host Chromium gate witnesses both actions against ordinary branch API responses and
  requires the notice to clear only after the resulting snapshot owns the durable leaf.
