---
purpose: "Pi owns branch semantics while same-file navigation and isolated fork creation retain explicit revision, writer, and publication boundaries."
covers:
  - server/runtime.ts
  - server/runtime-branch*.ts
  - server/session-{tree,projection,fork,fork-worker,export}.ts
  - server/generated-exports.ts
  - server/extensions/inspire-branch-bridge.ts
  - shared/{branch-node-actions,branch-bridge-protocol}.ts
  - src/controllers/branch-controller.ts
  - src/components/{BranchTree,EarlierBranchBanner,AppTopbar}.tsx
  - tests/server/{runtime-branching,session-fork,session-tree,branch-bridge-extension,session-export.integration,generated-exports}.test.ts
  - tests/web/{branch-tree,branch-store}.test.ts*
---

# History, branches and independent copies

## Goal

Inspect Pi history without changing the active conversation merely by browsing. Deliberately
navigate, edit from, fork, or clone its native paths without inventing alternate branch semantics.
Independent copies do not replace the active source worker. Durable trust comes from
[[session-persistence]]; browser continuity comes from [[session-transport]].

## Checks

### Pi-authoritative tree actions

- New sessions, naming, switching, compaction and same-file navigation use supported Pi operations;
  independent copies use `SessionManager` through the isolated boundary below. New-file
  materialization and worker admission belong to [[session-persistence]]. RPC uncertainty and
  completion-driven hooks belong to [[pi-integration]] and [[session-transport]].

  The branch tree is loaded through bounded projections of Pi entry identities, with older and alternate
  points still reachable and searchable. Route pages keep their containing user prompt visible when
  tool/event detail crosses a page boundary; that heading does not skip any retained activity.
  Complete retained text is read in bounded chunks. Native shell records expose the command, output,
  status and context inclusion as shell activity, not system bodies or storage JSON. Exact image
  coordinates remain Host-resolved and cancellable; saved images use the shared image viewer, with
  pointer/keyboard opening, fit/zoom, close and focus return. Retiring a read also retires its progress,
  while an older completion cannot clear a newer read's progress. Entry/image reads bind to their
  immutable entry and current transcript view, not the advancing branch revision: ordinary appends
  remain readable, while navigation and source/worker/view replacement retire the read. Mutating
  actions still require a fresh revision. A failed image offers Retry;
  contextual Refresh retries failed selected resources. History text uses the same authorized file
  preview actions as Transcript. Structured images render separately from descriptive placeholders;
  user-written placeholder-like text remains unchanged. A failed selected detail has a local
  retry that preserves search, loaded pages and the Back anchor. Read-only inspection never creates
  a navigation lease.
  Deliberate switching creates a non-evictable in-memory navigation lease until the next append
  durably commits that branch. Native edit targets return their text without submitting and move
  before the selected entry, including a root user's null parent and native custom-message targets.
  Do not assume every successful target becomes the resulting leaf.

- Same-file branch navigation requires an idle, fresh, conflict-free worker with no queued input or
  pre-existing dialog. Fork addresses its source by session id and requires that source's fresh
  branch revision, materialized current-format JSONL, conflict-free projection, and retained user
  target; that input need not already be on the active path. Clone includes its addressed endpoint
  rather than requiring an editable user input. An explicitly empty effective path clones to a native
  header-only destination. The Host's global selection is not an admission condition: another browser
  may select a different session or deselect without disabling copies in this browser's source view. Source run
  state, Pending queues, and extension dialogs are not preconditions because no source command or
  replacement occurs.
  Browser branch-tree and branch-action requests are owned by a bounded `BranchController`; its
  current API, transport generation, selection generation, selection intent and transcript view must
  still match before it can commit a response through `AppStore`. Tree reads and same-session navigation
  also bind the effective leaf. Independent copies admit an exact source prefix; ordinary source
  append progress must not prevent their destination from opening after publication. A
  bootstrap or selection replacement invalidates pending tree/action requests and clears their
  actionable presentation, including the old action marker when a successful response changes the
  view. Ordinary append can invalidate the effective leaf without replacing the
  view: the still-current request must retire its loading/action marker and expose refreshable stale
  history even when its result is discarded. It cannot clear a newer request's marker.

  Extension responses use a separate process-instance-validated per-slot FIFO, so navigation hooks
  can await browser input without deadlocking the mutation FIFO and each accepted response is
  delivered exactly once. Stale revisions and ambiguous navigation bridge outcomes fail closed; an
  unverified navigation stops the worker and reconciles disk instead of retrying.

### Same-file bridge

- Same-file navigation remains on stock Pi RPC through one inspire-owned explicit extension. Each
  worker receives randomized command, status-key, and worker identities; the host accepts only one
  bounded nonce-correlated `setStatus` result, awaits both that result and prompt completion, and
  independently verifies the post-operation leaf and Pi-owned persisted effects against the native
  operation, including expected branch-summary appends and before-target/null leaves. The internal
  command is hidden from completion and rejected at the public prompt boundary. The registered
  handler's RPC completion fences result delivery: completion without its matching result is a
  protocol failure, not a reason to wait indefinitely. Missing, duplicate, malformed, stale, or
  mismatched results are never retried after possible side effects.

### Independent Fork and Clone publication

- Fork and Clone create independent sessions, not source-runtime replacements. The host captures a
  fresh conflict-free committed projection and the selected retained endpoint, then a bounded one-shot
  process copies and verifies exactly that complete JSONL prefix into a private same-directory
  container. The process opens only the snapshot with the installed Pi SDK's `SessionManager`; it
  constructs no AgentSession or resource loader and never sends a command to, pauses, aborts,
  rebinds, or writes through the source worker. Source models, tools, extensions, queues, dialogs,
  and active work continue unchanged. Pi determines the ancestor path, labels, metadata,
  and generated destination identity. Fork excludes the selected user message and returns it as
  the destination Composer draft. Clone includes its endpoint and opens an empty destination
  Composer; it sends no new model prompt and leaves the source's draft and pending input in place.
  Neither action depends on whether the point happens to occur in the current History page.

  The helper canonicalizes the real source path as parent provenance and materializes header-only or
  otherwise deferred no-assistant output. Source appends and partial trailing writes beyond the
  admitted prefix may continue throughout fork without entering the destination. The host opens the
  private projection, reserves its id and final path, atomically publishes the complete JSONL
  without replacement, reopens it under that reservation, and attaches a processless destination
  before normal configured worker warm-up, independently of the Host's global selection. Concurrent
  open/create/delete operations share that reservation. Catalog-driven opens wait on the reservation.
  The response always identifies the destination for the requesting browser; automatic Host selection
  changes only if the source is still selected and no newer selection intent has occurred since fork
  dispatch, including while waiting for the source operation lane. Pre-publication failure removes
  staging, and post-publication failure identifies the committed destination instead of inviting a
  blind retry.

  Branch switching remains reversible and non-destructive; edit-from-here confirms only when it
  would replace a non-empty Composer draft. The action captures that draft's text/material revision;
  returned historical text may replace only that revision. Text or attachment/reference edits made
  while native navigation or summary is pending remain intact, even if their text later equals the
  confirmed draft. Native navigation still commits under its existing session/view/request fences.

### Optional branch summary

- A deliberate same-session continuation can carry Pi's summary of the branch being left, with
  optional custom instructions. Group node actions under This session and New session; user entries
  offer both Fork and Clone. A default-off Carry branch summary checkbox reveals optional
  instructions when selected. Its description identifies the conversation being left. Honor
  the native skip-summary-prompt preference. Summary
  generation is never a side effect of searching or previewing History. Cancellation follows Pi's
  native outcome rather than leaving the browser at a falsely completed destination. Ordinary summary
  cancellation uses native abort and preserves the worker/extension locals when it settles; confirmed
  retirement remains the fallback for an explicitly cancelled operation that cannot settle.
  Implementation evidence: [[follow-history-cloning-2026-10-02]].

### Export content and publication

- HTML preserves Pi's whole session tree. JSONL preserves the active branch's original native entries,
  embedded images and metadata, with a current native header and linear parents. Context edits affect
  model context, not exported raw history. Export never switches the source `SessionManager` or worker.
- Export captures content available at invocation, including during active work; it does not promise
  a future completed answer or lock later input. JSONL reuses the verified local prefix and reads only
  the native suffix/effective leaf; an unmaterialized session uses its owning worker's entries.
- Typed `/export` preserves Pi's one-path parsing, including quoted spaces and `~/`; `.jsonl` selects
  branch JSONL and other destinations use native HTML. It refuses the canonical source session and
  its symlink/hardlink aliases. Export and reload use writer admission under [[session-persistence]].
- Graphical Export creates a temporary native export, captures a private managed download and removes
  temporary source files on success or failure rather than leaving them in the workspace.
- Authenticated, session-owned opaque IDs serve captured snapshots, not caller-selected Host paths;
  later output changes cannot retarget them. Retain at most 16 downloads for 24 hours, remove them on
  shutdown, and require re-export after Host restart. Failed allocation remains retryable and every
  acquired source handle closes. [[composer]] owns the standalone dialog and typed receipts.

Checks: `tests/server/session-export.integration.test.ts` and `generated-exports.test.ts` cover native
content, active/empty branches, source protection and managed downloads.

### Earlier-branch presentation

- When the current view is a leased earlier branch, the center conversation surface projects a
  persistent `Continuing from earlier history` notice above the transcript with explicit return-to-latest
  and endpoint-inclusive `Clone from here` actions, independent of whether the History pane is open. Each action
  refreshes the runtime-owned branch projection before acting; the notice is derived from the
  runtime-owned durable/effective leaf pair and does not introduce browser branch authority.

  The mock-host Chromium gate witnesses both actions against ordinary branch API responses and
  requires the notice to clear only after the resulting snapshot owns the durable leaf.
