---
purpose: Separate Pi's interactive command ownership and model context from browser dispatch, chronological history, and observable operation feedback.
---

# Native command compatibility

## Boundaries corrected

Pi's interactive submit handler handles built-ins before calling `AgentSession.prompt()`. The RPC
`get_commands` resource list describes a different layer: extensions, prompts, and skills. INSΠRE
must not infer interactive precedence from that list. All built-in names now have their registered
browser or terminal-only owner; namespaced runtime commands and first-wire resource collisions
still work. A first-message composer hides unavailable native names, including colliding resources.
The Host repeats the ownership check after acquiring a fresh writer, uses exact case-sensitive
names, and normalizes command separators before Pi's literal-space dispatcher. This also closes a
reload race in which an admitted resource disappears before actual dispatch.

Pi's `buildContextEntries()` prepends the latest compaction for model consumption. The transcript
retains exactly those selected entries but restores persisted append order before deriving message
and user-turn identities. It does not sort timestamps, modify model context, resurrect discarded
context, import unrelated branches, or rewrite the session file. Thus a compaction follows retained
prior messages and precedes subsequent messages on live update, reopening, and branch inspection.

Compaction failure and cancellation notices follow observed Pi outcomes for every trigger. A manual
trigger is not evidence that the observing browser still owns a local HTTP receipt. Successful
summaries are never invented from events; they come from persisted history. Errors remain transient
attention rather than a new durable error log. A local failure receipt may coexist with that notice;
there is no guessed operation correlation that could suppress another browser's error.

Summarization retry details are independent of ordinary agent retries and of the enclosing run
state. Host snapshots retain validated attempt counts and a bounded reason while work is active.
Attempt-start, retry-finished, compaction-end, settlement, and worker loss retire those details.
Backoff does not change `compacting` to `retrying`, preserving standalone compaction cancellation.
No countdown or percentage is inferred from token occupancy.

Local receipts retain `createdAt` for lifecycle metadata but no longer display request time in
headers. Successful compact receipts stop occupying the composer dock once later agent work or
compaction starts; persistent checkpoints remain in the transcript. Simple command success
(`/copy`, argument-bearing `/name`, exact `/model`, valid `/thinking`) uses a short notice and
retires its running receipt; failure retains a receipt with the actual cause, without a second
control-level warning. Control invocations still own their own warning notices. Mutation outcomes
separate success, actual failure, and lost ownership; background command failures update their
originating receipt without showing a notice over another session.
Terminal-only capability is part of the option description rather than an inaccessible group label.
Reload explicitly says that the worker was replaced; terminal guidance does not imply that opening
a shell transfers ownership of the current session.

## Compaction-time delivery boundary

Pi TUI's compaction input queue is not the public RPC prompt surface. The Host instead holds a
bounded transient queue attached to the same session, worker instance, and explicit branch-selection
identity. Compaction can legitimately renew the browser view while retaining that selection. Its Pending
projection composes that queue with Pi's public text arrays. Clear owns both at the operation
boundary, and worker/branch replacement rejects undelivered input for browser recovery rather than
writing to another history. Actual Pi streaming state, not a Host `queued` label, decides whether
Steer/Queue joins a live agent or must wait behind the original preflight/extension command.

Each browser delivery has an independent operation record and attachment handoff. A slow receipt
cannot block later input, and a failed older delivery cannot clear a newer editor or in-flight
partition. The original prompt operation identity continues through the Host's 20-second receipt
observation window; uncertain outcome retains its retry identity. This does not invent a durable
shadow conversation or claim that a Host-held item is already Pi history.

## Deliberate limits

HTML export, worker-based reload, and worker-based compact cancellation remain bounded existing
operations. This change does not add JSONL import/export, session clone, authentication, trust,
sharing, scoped-model configuration, or context-integrated shell execution to the browser. It does
not persist an estimated after-token count that Pi did not record, and does not automatically
replay missed transient failures after reconnect. These limits are described in the README.

## Regression evidence

- Server projection: skewed timestamps, retained-before/checkpoint/after ordering, disk reopen,
  repeated compaction, historical branch selection, and byte-preserving read-only projection.
- Command routing: every installed development-baseline built-in is classified; collisions,
  namespaced commands, exact casing, pasted separators, and queued reload retirement are covered.
- Feedback: manual outcomes without local receipts, live and snapshot-restored compaction backoff,
  invalid counters, detail bounding and retirement, and receipt time/lifecycle are covered.
- Offline real-Pi integration covers the public SDK/RPC preflight boundary without a paid provider.
  Focused fake-worker and browser tests cover Host-held Pending, Clear, long extension receipts,
  separate operation identities, and composer command presentation; they do not claim a provider
  compaction quality result.

Relevant contracts: [[pi-integration]], [[composer]]. Historical background: [[state-authority-review]].
