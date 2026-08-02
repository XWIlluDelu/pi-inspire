---
purpose: A trusted local host runs the user’s actual Pi environment and exposes only the typed controls and projections needed by the replaceable web interface.
covers:
  - server/**
  - shared/contracts.ts
  - src/api.ts
  - src/store.ts
  - src/components/ExtensionUiDialog.tsx
  - tests/server/**
---

# Pi integration

## Goal

Use Pi as the sole agent runtime while keeping privileged local capabilities out of the browser.

## Checks

- The local host uses the active Pi installation or a clearly reported compatible runtime rather than implementing an independent agent loop.
- The normal Pi agent directory and project working directory remain authoritative for settings, credentials, models, extensions, skills, prompts, context files, and sessions.
- The browser receives model availability and runtime state but never stored credential values.
- Local-file preview requests are authenticated and bound to the selected Pi session: every path requires an exact authoritative session reference, with relative paths resolved against that session’s project directory.
- Pi message, tool, queue, retry, compaction, session, and extension-interaction events cross a typed, validated host interface. RPC JSONL input is line-bounded and assembled without repeated prefix copying: a child emitting an oversized unterminated line loses only its own worker instead of growing or stalling the long-lived host without limit.
- The host rebinds event subscriptions and extension interaction after any Pi operation that replaces the active session runtime.
- Worker startup establishes a trusted projection tail (or trusted empty baseline), constructs the process, then immediately reconciles again before `rpc.start()` and requires identity/stat version, revision, tail, fingerprint, and committed bytes to be unchanged. Projection readers remain serialized behind the boundary. After start, the only accepted delta is one strictly bounded, direct, contiguous append composed of installed-extension non-transcript `custom` state plus at most one missing `thinking_level_change`; `get_entries`, `get_state`, and disk must agree on every entry, parent, final leaf, session, path, thinking level, and append lineage before the writer baseline advances. This establishes state equivalence, not causal authorship: stock public RPC cannot distinguish an exactly matching entry from a prohibited concurrent writer in the interval after the second baseline. The one-writer rule remains authoritative, and messages, model changes, compactions, unsupported or oversized mixed deltas, wrong parents or values, path/session mismatch, filesystem-object change, and rewrites stop the worker.
- Same-file navigation remains on stock Pi RPC through one inspire-owned explicit extension. Each worker receives randomized command, status-key, and worker identities; the host accepts only one bounded nonce-correlated `setStatus` result, awaits both that result and prompt completion, and independently verifies the post-operation leaf and absence of persisted deltas. The internal command is hidden from completion and rejected at the public prompt boundary. Missing, duplicate, malformed, stale, or mismatched results are never retried after possible side effects.
- Fork uses Pi's stock RPC replacement command and final `get_state` identity. Ordinary events are buffered under strict count and byte caps until the process is rebound; response-bearing hook dialogs bypass that buffer under the source identity and unresolved requests alone are rebound. The verified destination id/path is synchronously reserved while its projection opens, so catalog refresh/open cannot start a competing child; identity/path collisions or source divergence stop the child instead of guessing ownership.
- Extension dialog responses are non-persisting and use a per-slot FIFO independent of persistence mutations. The host revalidates request id, source session, current process instance, expiry, and conflict state inside that lane, sends once, then removes the pending request. An installed-Pi integration runs the real `RuntimeController` with test-isolated explicit bridge and hook extensions, answers awaited tree/fork confirm/input requests through this lane, and witnesses navigation, fork rebind, post-fork navigation, and one process.
- The installed-Pi boundary is executable without paid model inference: an isolated test proves byte-preserving read-only preview plus real RPC state, bounded incremental entries, tree, model selection, commands, statistics, all dialog and fire-and-forget extension UI methods, extension-supplied offline compaction, session-directory replacement, switch, and fork. The branch-specific `RuntimeController` integration independently proves bridge/hook behavior and worker rebind.
- Dialog-style extension interaction has a web-native presentation or a clear fallback.
- Terminal-only extension components do not prevent the underlying tool or command from working when a generic web presentation is possible.
- Extension failures remain attributable to their originating lifecycle and operation; the host does not silently suppress, retry, or reinterpret them through extension-specific catch-all behavior.
- Pi’s saved project-trust policy remains authoritative; the host does not load project resources through a separate bypass path.
- The host binds locally by default and does not expose unrestricted Pi control to another machine. Production launch is single-instance and idempotent per checkout/host/port: reuse requires an authenticated constant-size health response; `stop`/`restart` signal only the exact private-state process whose owner, kernel process-start identity, working directory, and command line match; a stop racing dependency installation or build cancels that pending start; and an unknown port occupant is never killed automatically. A joining WebSocket has a bounded pre-snapshot event backlog, and an established slow client is closed once its outbound buffer crosses the host limit; reconnecting obtains a fresh authoritative snapshot instead of retaining unbounded deltas.
- The mock host is a deterministic presentation fixture, not a second Pi implementation or runtime-conformance oracle; security and lifecycle guarantees are witnessed against `RuntimeController` and `PiRpcProcess` directly.

## Non-goals

- Complete visual compatibility with every third-party TUI component is not required.
- The browser is not a general remote shell or direct filesystem client.
