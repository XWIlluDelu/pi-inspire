---
scope:
  - server/session-projection.ts
  - server/session-tree.ts
  - server/extensions/inspire-branch-bridge.ts
  - server/runtime.ts
  - server/app.ts
  - shared/contracts.ts
  - src/api.ts
  - src/store.ts
  - src/components/ResourcesPane.tsx
  - src/components/BranchTree.tsx
  - src/styles.css
  - tests/server/**
  - tests/web/**
---

# Session tree and branching

## Objective

Expose the active Pi session tree and supported fork, edit-from-here, and branch-switch operations without mutating JSONL behind a live runtime or misattributing a replacement session.

## Completed state

- [x] Reused the single bounded `SessionProjection` reader, watcher, cursor, revision, and leaf authority. The browser receives lightweight ordered tree nodes, bounded snippets, active-path identity, durable/effective leaves, projection health, and explicit truncation.
- [x] Added a `Branches` mode to the existing contextual pane. Rows expose branch switch, edit-from-here, and fork only where the host contract supports them; destructive-looking transitions require confirmation and errors stay visible.
- [x] Kept stock Pi 0.83 RPC. One inspire-owned explicit extension bridges the public `ExtensionCommandContext.navigateTree(..., { summarize: false })` method through randomized per-worker command/status identities and a bounded nonce-correlated result.
- [x] The host awaits both the correlated status result and prompt response, verifies the effective leaf through bounded `get_entries { since }`, independently reconciles disk, and never retries an ambiguous side effect. Missing, malformed, duplicate, stale, wrong-worker, wrong-nonce, cancelled, and timed-out outcomes are handled explicitly.
- [x] Navigation creates an in-memory non-evictable lease when Pi changes only its process-local leaf. Transcript/tree projection uses that effective leaf; the next owned append durably commits it, returning to the durable leaf clears it, and worker stop drops it.
- [x] Edit-from-here navigates to the selected user entry's parent and copies bounded original text into the composer without sending. Pi's public API cannot edit the root user entry, so that action is disabled and rejected truthfully.
- [x] Fork uses Pi's stock RPC replacement operation. The host buffers ordinary events under 1,000-event/2 MiB caps, emits response-bearing fork-hook dialogs under the source identity, obtains and validates final identity/path, leaves the source projection processless, rebinds the same process and only unresolved extension requests to the destination, replays buffered events under the final id, invalidates the catalog once, and lets newer selection intent win.
- [x] Branch persistence operations share the runtime mutation FIFO and require an idle, fresh, conflict-free slot with no pre-existing dialogs or queues. Extension responses use a separate process-instance-validated per-slot FIFO so a tree/fork hook can be answered while its mutation is blocked; request ownership is revalidated and each response is delivered at most once.
- [x] Worker creation is followed by a second exact disk/projection baseline reconciliation immediately before `rpc.start()`, covering identity/stat version, revision, tail, fingerprint, and committed bytes. After start, readiness may accept only a bounded contiguous append made exclusively of installed-extension `custom` state and at most one missing-thinking initializer, and only when bounded RPC state, session/path, direct append lineage, unchanged filesystem object, entry equivalence, final leaf, and thinking level all match before advancing the writer baseline. Empty baselines are bounded too; factory-side injection, wrong-level, bad-parent, transcript/model/compaction entries, unsupported or oversized mixed deltas, and rewrites stop. This is deliberately a state-equivalence exception, not a causal Pi-ownership claim: public RPC cannot distinguish an exactly matching forbidden concurrent append after the second baseline, and the one-writer rule still applies.
- [x] A verified fork destination is synchronously reserved by both id and resolved path before projection open. Catalog-driven opens wait for reservation completion, attachment rechecks ownership without yielding, and every success/failure path releases the reservation.
- [x] Snapshot/page cursors, browser paging, and resource handles carry an opaque branch-view generation. Explicit navigation, worker reset, and non-append projection replacement change it; ordinary appends do not. Same-session branch changes abort/discard older-page and resource work, while content serving revalidates the current view plus citation/index/embedded authority.
- [x] Tree entry/parent identities have explicit char/byte caps, active paths contain only projected nodes, and the complete response is bounded to 512 KiB.
- [x] Added focused projection, protocol, runtime, route, store, and browser tests plus installed-Pi `RuntimeController` witnesses for real startup initialization, installed-extension custom-state persistence, response-lane confirm/input, navigate, fork rebind, and post-fork navigate with one process. The deterministic branch integration disables discovered extensions only inside that test while loading bridge/hook extensions explicitly; production argv is separately witnessed to retain ordinary extension discovery while adding the explicit bridge.

## Decisions

- Fork creates a new Pi session; branch navigation changes the effective leaf within one session. The UI and host never conflate them.
- The contextual tree is the primary branch projection. Transcript-rail marks remain optional.
- Pi JSONL remains the only durable conversation authority. inspire never rewrites it to simulate navigation.
- Summarized navigation is not exposed because it can invoke a model; all current branch switches use `summarize: false`.
- A host bridge timeout is an outcome-unknown failure after dispatch, not permission to retry.

## Verification

- `npm run check`
- `npm run build`
- `tests/server/pi-branch-bridge.integration.test.ts` executes against the installed pinned Pi runtime with ordinary extension discovery disabled and only explicit deterministic bridge/dialog-hook extensions. A separate production-factory test proves normal worker argv does not use `--no-extensions` and still adds the explicit inspire bridge.
