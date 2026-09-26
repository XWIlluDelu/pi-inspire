---
purpose: Explain native-command dispatch, compaction presentation, and input ownership at the Pi RPC boundary.
---

# Native command compatibility

Contracts: [[pi-integration]], [[composer]], and [[conversation]]. The supported command table is
in `README.md`; the remaining presentation proposal is in [[follow-native-command-surface-2026-09-04]].

## Command ownership

Pi's interactive submit handler resolves built-ins before `AgentSession.prompt()`. RPC
`get_commands` lists extensions, prompts, and skills instead. `shared/commands.ts` therefore
reserves built-in names for their browser or terminal-only handler; namespaced extension commands
remain available. First-message completion hides native commands that need an existing session,
including colliding resource names.

The Host repeats the ownership check after acquiring a fresh writer. Names are case-sensitive,
and separators are normalized for Pi's literal-space dispatcher. This prevents a resource removed
by reload from reaching the model as an ordinary prompt. `/compact` also has a Host-owned
first-message path. Terminal guidance opens a separate shell; it does not attach that shell to
the active Pi session.

## Compaction and feedback

Pi's `buildContextEntries()` puts the latest compaction first for model context. The transcript
uses the same selected entries in persisted append order: retained messages, checkpoint, later
messages. This changes presentation only; model context and the session file remain intact.

Summaries come from persisted history. Failure and cancellation notices follow Pi events, including
operations started by another browser. These notices are transient. A local failure receipt can
coexist with one because the event does not identify which browser operation it belongs to.

Summarization retries have their own snapshot-backed attempt count and bounded reason. Attempt
start, retry finish, compaction end, settlement, and worker loss clear them. Backoff retains the
`compacting` state so standalone cancellation remains available. Occupancy is not progress, and
historical after-token counts are shown only when Pi recorded them.

Command headers omit time; `createdAt` remains metadata. A successful compact receipt retires when
later agent work or compaction starts, while its checkpoint stays in the transcript. Simple success
(`/copy`, argument-bearing `/name`, exact `/model`, valid `/thinking`) uses a short notice; failure
keeps one attributable receipt. Lost response ownership retains an unknown outcome. Control
invocations own their warnings separately. A background command updates its own receipt without
posting a notice over another session.

## Compaction-time delivery

Pi TUI's compaction queue is separate from RPC prompt admission. The Host holds bounded input for
the same session, worker, and explicit branch selection, and combines it with Pi's public queues
in Pending. Compaction can renew the browser view without replacing that selection.

Pi's actual streaming state decides delivery: an active agent can receive Steer/Queue while an
earlier receipt is pending; otherwise input waits behind the existing preflight or command. Clear
removes undispatched Host input and clears Pi's queue. Worker or branch replacement returns
undelivered input for recovery rather than sending it to another history.

Each delivery owns its operation identity and attachment handoff. An older receipt cannot block
later input or clear a newer draft. The Host's 20-second HTTP observation window retains that
identity; an unknown outcome keeps it for recovery. Host-held input becomes conversation history
only when Pi persists it.

## Regression evidence

- Projection tests cover persisted ordering despite skewed timestamps, repeated compaction,
  reopening, branch selection, and unchanged source bytes.
- Routing tests classify the development-baseline built-ins and cover collisions, namespaces,
  casing, separators, and resource changes during reload.
- Feedback tests cover outcomes without local receipts, snapshot-restored retry state, bounded
  counters/reasons, and receipt lifecycle.
- The real-Pi fixture uses a local synthetic provider to exercise preflight compaction. Runtime and
  browser tests cover Pending/Clear, long extension receipts, independent input ownership, and
  command presentation. [[state-authority-review]] records the earlier presentation repairs.
