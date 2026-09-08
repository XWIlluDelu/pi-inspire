---
purpose: A trusted local host runs the user’s actual Pi environment and exposes only the typed controls and projections needed by the replaceable web interface.
covers:
  - inspire
  - deploy/systemd/**
  - scripts/source-build-hash.mjs
  - scripts/write-build-stamp.mjs
  - server/**
  - shared/contracts.ts
  - src/api.ts
  - src/store.ts
  - src/events.ts
  - src/components/AppTopbar.tsx
  - src/components/ExtensionDisplays.tsx
  - src/components/ExtensionUiDialog.tsx
  - docs/extensions.md
  - tests/server/**
  - tests/web/app.test.tsx
  - tests/web/events.test.ts
  - tests/web/store*.test.ts
  - tests/web/transcript-inspection.test.tsx
---

# Pi integration

## Goal

Use Pi as the sole agent runtime while keeping privileged local capabilities out of the browser.

## Contract map

- [[host-lifecycle]] — pairing, installed-runtime distribution, process/service ownership, diagnostics, and build publication.
- [[session-persistence]] — exact worker-startup and persistence trust boundary.
- [[session-branches]] — the same-file RPC bridge and processless source-independent fork.

## Checks

### Installed runtime and typed controls

- The local host resolves the user's separately installed `pi` executable, loads the public SDK from
  that executable's package root, and starts every RPC worker from the same package root. Pi version
  metadata is reported but does not gate startup; the concrete public APIs INSΠRE calls are the
  compatibility boundary. The INSΠRE checkout's development dependency is never a production runtime
  fallback.

- The normal Pi agent directory and project working directory remain authoritative for settings,
  credentials, models, extensions, skills, prompts, context files, and sessions.

- The browser receives model availability and runtime state but never stored credential values. Its
  Settings surface can change Pi's auto-compaction, auto-retry, steering-delivery, and
  follow-up-delivery settings through typed authenticated controls; the worker and Pi
  `SettingsManager` remain the authorities. Optimistic changes have per-field request ownership
  scoped to the current browser selection and transport; an older failure cannot roll back a newer
  request even when their values match, and a current failure reconciles with Pi rather than
  trusting an optimistic predecessor.

- Pi RPC `get_commands` enumerates extension, prompt, and skill resources but not Pi's interactive
  built-ins. A shared explicit registry therefore classifies built-ins as browser-native, bounded
  Host/RPC operations, informational, or terminal-only; where no Pi runtime resource owns the same
  name, the Host independently rejects built-in or unknown command-shaped text and shell syntax at
  the ordinary prompt boundary so a stale or non-browser client cannot send it to the model
  accidentally. Pi runtime-resource precedence is retained, except that `/compact` is always
  Host-owned.

- Manual compaction is a standalone host operation with Pi's three-minute command allowance rather
  than the browser prompt-confirmation window. Because stock Pi exposes no `abort_compaction` RPC,
  cancelling a standalone compaction stops only its owning worker, classifies the interrupted
  compact request as cancelled rather than outcome-unknown, and starts a fresh worker on demand
  while the JSONL projection remains authoritative. HTML export and resource reload use the same
  serialized writer authority; reload invalidates resource/model inventories before worker
  replacement.

- Project terminals remain outside Pi's runtime and session history: a separate terminal daemon owns
  their PTYs, metadata, and optional history, the Host is only their authenticated gateway, and no
  Pi prompt or Extension receives implicit authority to read or write a human terminal.

- Local-file preview requests are authenticated and bound to the addressed open Pi session and its
  projection view, independently of the Host's default selection or another browser's navigation. A
  path requires either an exact reference in that session's authoritative message projection or
  membership in its workspace index, and relative paths resolve against the session’s project
  directory.

### RPC delivery and ownership

- Pi message, tool, queue, retry, compaction, session, extension-interaction, and persistent
  `entry_appended` events cross a typed, validated host interface. Every entry that Pi reports as
  persisted contributes an exact expectation, including extension `custom` entries; if disk
  observation wins that event race, a bounded worker `get_entries` delta may attest only when the
  entire observed append is an exact persisted-JSON prefix of the worker's contiguous chain from the
  trusted leaf. Worker-only trailing entries remain unaccepted until disk observation, and claims
  arriving during the lookup are consumed only through the observed prefix. Privacy-safe diagnostics
  record the observed and worker counts, immutable leaves, and worker-ahead delta without entry
  payloads.

  RPC JSONL input is line-bounded and assembled without repeated prefix copying: a child emitting an
  oversized unterminated line loses only its own worker instead of growing or stalling the
  long-lived host without limit.

- The Pi RPC stream accepts only bounded valid-UTF-8 JSON object frames. A correlated response must
  carry the pending request id, exact command, and explicit success value; malformed, mismatched,
  oversized, or unexpectedly closed streams retire the whole worker instead of dropping a frame and
  continuing with ambiguous ordering. Startup, stdin delivery, and response waits are bounded. Once
  a mutating frame enters Node's write buffer, write failure, timeout, or child loss is reported as
  acceptance-unknown and exposes the worker-stop promise to recovery; a failed read-only request is
  not mislabeled as a mutation conflict, but still retires the unusable protocol stream.

- Pending supports the public `queue_update` text arrays and explicit confirmed `clear_queue`, not a
  separately negotiated structured management protocol. Unsupported pause/resume, per-item
  deletion/conversion, text-fetch RPCs, and startup capability probes are absent from the production
  contract and its Fake RPC fixtures. A clear receipt does not claim that a racing already-consumed
  entry was retracted; authoritative queue events own the resulting display.

- Worker replacement retires its event ownership and outstanding extension requests. A new-session
  worker keeps its existing provisional slot while its public session identity is finalized; an
  independent fork never transfers subscriptions or dialogs from the source worker.

- Extension dialog responses are non-persisting and use a per-slot FIFO independent of persistence
  mutations. The host revalidates request id, source session, current process instance, expiry, and
  conflict state inside that lane, sends once, then removes the pending request. Fork leaves this
  lane and every unresolved source request attached to the source worker.

- The installed-Pi boundary is executable without paid model inference: an isolated test proves
  byte-preserving read-only preview plus real RPC state—including text-only Pending queue events and
  the real public `clear_queue` operation—bounded incremental entries, tree, model selection,
  commands, statistics, all dialog and fire-and-forget extension UI methods, extension-supplied
  offline compaction, session-directory replacement, switch, and Pi's native fork capability.
  Runtime tests independently prove same-file navigation and isolated SessionManager fork while a
  source worker remains active.

### Extension presentation

- Dialog-style extension interaction has a web-native presentation or a clear fallback. Generic
  persisted extension content uses available extension attribution as its normal-font title, falls
  back to the neutral label `Extension`, and keeps raw method/type and payload inside the
  inspectable body instead of presenting `custom` as product language.

- Short keyed Pi status values are bounded before Host retention, restored by authoritative
  snapshots after browser reconnect, deterministically ordered in quiet desktop top-bar text, and
  cleared with the owning worker rather than surviving as browser-only state.

- Pi RPC string-array widgets retain their stable key, update/clear lifecycle, and
  `aboveEditor`/`belowEditor` placement in a bounded, native surface immediately around the
  Composer. Oversized keys are rejected rather than truncated into a colliding identity. Terminal
  control sequences are display-cleaned rather than interpreted. Component factories remain
  terminal-only; malformed, oversized, and explicitly one-way unknown display events use the bounded
  attributable raw fallback.

- Terminal-only extension components do not prevent the underlying tool or command from working when
  a generic web presentation is possible. INSΠRE does not identify third-party Extension packages or
  expose arbitrary browser code/style injection; the public adaptation guide explains the exact RPC
  compatibility boundary, semantic and visual placement rules, source-level seams, and
  representative Todo, usage, and custom-Tool recipes.

- Extension failures remain attributable to their originating lifecycle and operation; the host does
  not silently suppress, retry, or reinterpret them through extension-specific catch-all behavior.

## Non-goals

- Complete visual compatibility with every third-party TUI component is not required.
- Pi integration is not itself a shell or direct filesystem client; the explicitly selected [[terminal]] surface is the sole general-shell boundary.
