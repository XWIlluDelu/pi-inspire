---
scope:
  - server/**
  - shared/**
  - src/**
  - tests/**
  - docdoki/specs/{composer,pi-integration,conversation}.md
  - docs/pi-commands.md
---

# Native direct shell input

## Outcome

Native `!`/`!!` input is implemented under [[composer]], [[pi-integration]] and [[conversation]].
Command UX is recorded separately in
[[follow-command-ux-2026-10-02]].

- `!command` runs through Pi and includes its result in subsequent model context. `!!command` records/
  displays the result but excludes it from context. Neither starts a model turn; the project terminal
  is independent. Pi owns cwd, policy, `user_bash` hooks, persistence and cancellation.
- `server/runtime-bash.ts` dispatches native `bash` RPC with `excludeFromContext` and matches deltas by
  request ID. Existing delivery receipts provide retry/idempotency ownership; no second runner or
  injected model tool executes shell input.
- Independent `bashRunning` state preserves native concurrent model work and rejects a second shell.
  Shell-only Composer retains ordinary Send beside Stop; `!` drafts name their action Run shell.
  Shell-only Stop uses `abort_bash`; model/compaction Stop takes precedence when both run.
- Result cards show output, running/exit/cancelled status, context inclusion, truncation and Copy,
  independently of assistant tool visibility. **View full output** opens the native saved log through
  the existing session-authorized resource viewer. History projects/searches shell command and result
  without treating them as hidden system bodies. Live output is bounded. Input history
  restores the correct prefix. Results during streaming can persist only at `agent_end`; matching
  uses the native payload rather than the Host preview timestamp.
- Pi installs Bash cancellation after `user_bash` hooks. Explicit Stop during a suspended hook dialog
  or unresponsive native cancellation uses confirmed worker retirement. Interrupted cards retain known
  output without inventing exit/cancellation/persistence. Unacknowledged requests report unknown
  acceptance and are not automatically replayed.
- Shell input rejects attachments/project references while preserving staged input.

## Evidence and limits

Eight `native shell input` cases in `tests/server/pi-operation-lifecycle.integration.test.ts` passed
with explicitly selected installed **Pi 1.0.0** and pinned **0.87.0**. Isolated local synthetic fixtures
cover cwd, tagged streaming, included/excluded subsequent context, no automatic model turn, receipt
reobservation, persisted/reopened results, extension-provided/custom execution, exit/truncation/full
output, cancellation/duplicate-shell refusal, hook answer/Stop, worker interruption, deferred
persistence, model-first Stop and pre-prompt compaction concurrency.

Focused boundary/runtime/projection/history/card/Composer tests passed for foreign deltas, bounded
preview, exact final results, independent shell state and Send/Stop behavior. Fresh-build Chromium
shell wiring and draft regressions passed at desktop and 390px: Run shell, ordinary Send during shell,
streamed/context-labelled cards, Escape/Stop and Up/Down history. Browser fixtures establish UI wiring;
the real-Pi cases establish execution semantics. Typecheck and scoped lint passed in the final shared
gate.

The full-output repair is verified by fresh-build desktop/390px `history.spec.ts`: click the actual
shell action, check its originating session/reference request and compare all viewer text to the
2,500-line log. Saved `!`/`!!` entries appear in outline/search/detail with their context flags and
supported Continue/Clone boundaries. An explicit Pi 1.0.0 truncation case checks its persisted native
entry through `SessionProjection` and `SessionTreeReader`; no model request is needed.

Both recorded Pi versions provide the shell RPC surface exercised here; the current test baseline
is tracked in [[dependency-boundaries]]. Execution/browser checks ran on Linux/direct RPC. Herdr and macOS/Windows were not rerun for this unit;
they use the same selected-worker RPC path.
