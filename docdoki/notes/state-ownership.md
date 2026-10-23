---
purpose: Ownership patterns for asynchronous work, runtime observations and recoverable operations.
---

# State and operation ownership

## Address and generation

Session identity addresses the data; a selection generation identifies the visit that may publish it.
An A → B → A navigation cycle therefore has two different owners for A. Delayed refreshes, rollback,
errors and loading cleanup must check the originating generation, even when the session ID matches.

Loading-marker ownership is distinct from result freshness. A request may still own the marker that
needs clearing after its payload becomes stale; a retired request must not clear a newer marker.
Apply the same ownership check to success, failure and `finally`, not just the successful payload.

Session-addressed resource reads, forks and preview warming use the target slot rather than the
Host's global selection. Capture automatic-selection intent before queued work begins; capturing it
after reconciliation can overwrite a choice made while the request waited.

See `src/store.ts`, `src/controllers/branch-controller.ts`, `server/runtime-reads.ts` and
`tests/web/store-async-ownership.test.ts`. Contracts: [[session-transport]], [[session-branches]].

## State and observations

The initiating UI owns submission guards. The runtime owns execution state. Snapshots and events
project that state; receipts report an operation's outcome. This separation keeps compaction,
retry and update presentation consistent across GUI commands, hooks, reconnect and reload.

Explicit Host status wins over heuristic event-name inference. In particular, a settling event must
not turn an explicit failure into idle. Reconnect restores current state without replaying completion
alerts.

Reads may time out while native execution continues. Prompt acceptance, operation completion and
confirmed worker retirement are separate boundaries. Replacement requires confirmed exit;
Herdr additionally requires an empty worker scope. See [[pi-integration]] and [[session-persistence]].

## Recoverable reads

`RecoveryBackoff` supplies the shared bounded retry timing, not permission to repeat an operation.
Callers authorize every read under its API, transport, session/view and input scope; cancellation
retires both pending waits and late completions. Preserve confirmed data while revalidating the same
scope, and clear the corresponding error only when that read succeeds. Authentication, invalid
configuration and persistent unavailability keep their actual user-facing boundary.

Awaitable backoff preserves the initiating read promise. Older-message paging therefore keeps its
viewport anchor and loading owner across transient failures instead of prepending later through an
unrelated callback. Abort/reset settles a waiting promise so retired reads cannot hold UI ownership.
Directory/model previews and workspace directory/search reads share this mechanism; none of these
recoveries replay session creation, messages or other writes. See `src/recovery-backoff.ts`,
`src/controllers/{transcript-data,workspace}-controller.ts` and `src/components/Welcome.tsx`.

## Durable operations and catalogs

A terminal mutation carries the same operation ID through browser, Host and daemon. A lost response
retains an unresolved operation; checking it reuses that ID rather than creating a second mutation.
Receipt reclamation fences the old admission epoch before forgetting results.

Partial mutation receipts can advance a revision without establishing complete catalog membership.
An equal-revision full catalog must still reconcile membership and ordering. Epoch changes require
a full catalog; older epochs cannot overwrite it. See [[terminal]] and
`src/terminal-catalog.ts`.

Configuration saves invalidate discovery at the successful write boundary, before optional readback.
A failed readback must not leave cached old configuration or turn a successful save into failure.
Monotonic catalog generations prevent older reads from refilling invalidated caches.
See `server/model-settings-routes.ts` and [[model-settings]].

Pending dequeue is also a handoff, not just a mutation acknowledgement. Retain its exact returned
text and image handles under the operation identity before returning HTTP; otherwise a successful
clear followed by a lost response leaves nothing to retry. Reconnect observes that receipt on a
new observer rather than joining a blackholed mutation promise. See [[session-transport]],
`server/pending-operation-receipts.ts` and `src/controllers/pending-recovery-controller.ts`.

## Component and module ownership

Split modules where state, transport or lifecycle ownership changes. A facade that only forwards
callbacks adds no boundary; a socket subscription owner or PTY gateway does. Organize regression
fixtures by those responsibilities so distinct failure modes remain independently testable.

React StrictMode can replay a modal's layout effect after focus has entered the dialog. Preserve
the original outside opener rather than capturing the focused close button as its replacement.
Otherwise unmount restores focus to a removed node and leaves it on the document body.
See `src/use-modal-focus.ts` and `tests/web/modal-focus.test.tsx`.
