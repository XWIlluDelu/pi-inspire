---
scope:
  - src/**
  - server/**
  - shared/**
  - extensions/**
  - scripts/**
  - tests/**
---

# Handbook simplification

## Objective

Implement the [simplification handbook](https://chatgpt.com/space/page_0b1050404f0c8191b1a18d9d168e6141)
while retaining native Pi files, active configuration and the observable behavior specified by the
project. The main plan estimates 64,335–90,055 net source lines including test replacements.
Measure the implementation against `3e123767` using the handbook's source inventory. The optional
attachment-retention and PDF experiments are outside the main plan.

## Current state

- Saved-session queries share the JSONL reader and bounded history transport. Fork and Clone use
  Pi's native branch operation in a thread over a verified prefix. Resource transfers open the
  authorized logical path and validate range versions. HTML keeps the captured document and uses
  the same resource authority.
- The conversation separates the bounded Live tail from the saved native-turn reader. History
  reads one page at a time, pins its leaf, searches unloaded entries and restores a saved entry
  and body section. The title menu, palette and `/tree` open that reader. Reading, routes, search,
  entry bodies and branch actions replaced the separate contextual outline and its transport.
  Same-session navigation carries the inspected revision; copies retain independent admission.
  The browser query type is inferred from the Host's history schema. Live and History share the
  Shell card and keep structured log references separate from stdout.
- Ordinary session open, reconnect and Fork/Clone do not start an owned Pi. An explicit action
  admits a writer if needed. Cold history still observes an external owner, and normal admission
  checks ownership again before writing.
- Thinking level and per-session runtime settings keep confirmed values separate from pending
  writes. Deletion applies the committed result once and keeps confirmed navigation metadata
  when cleanup fails.
- The workspace tab strip scrolls and offers one searchable list for files and terminals. The
  old width-based hide/show registry and mutation observer are gone. The dock renders terminal
  tab descriptors directly; terminal output and control lifetimes stay with their existing owner.
- The start and session editors render their stored text directly. Input history copies text and
  artifacts on explicit selection. Provider and extension prompts share form controls.
- Update probes share a cache owner. Live and saved views share snapshot assembly without
  retaining transcript snapshots in slot metadata. Each socket owns its subscription state, and
  each Pi dialog owns its process and deadline. Deletion reservations share a registry. A lost prompt response
  triggers a bounded read of its original Host receipt. An unchanged retry observes the same
  receipt without sending the prompt again. Composer keeps in-flight, uncertain and recoverable
  prompt states under one operation identity. Terminal data and maintenance share one
  wire version. Current credentials, Herdr scopes and attach-control entry paths are in use.
- The owned Pi bridge publishes bounded native checkpoints. The disk reader verifies the file
  independently, including appends from a second Pi. Live adopts finalized native entries from
  checkpoints, preserves unconfirmed output and no longer claims authorship from file appends.
  Reconnecting sockets replay only events newer than their runtime snapshot cut.
- The notification service receives settled outcomes from the runtime and attached receiver,
  without reconstructing runs from browser events.
- The last-opened hint supplies a fresh browser's starting address. It no longer controls worker
  retention, addressed reads or another browser's completion and failure indicators.
- A Live replacement delivers the bounded rows, branch and persistence diagnostics together.
  Join replays only events after the snapshot cut, including cuts within a token batch. A stale
  HTTP observation and sequence from an earlier Host cannot displace the current view.
- Prompt, Stop and Return use one Host operation receipt with typed inputs and matched executor,
  command and ID. Stop/Return retries observe only; retirement stays unknown and concurrent
  confirmation restores the result once.
- `inspire pi` runs the native Pi terminal with its public SDK and returns the individual queue
  disposition for remote Steer and Follow up. A regular terminal Pi does not return that
  disposition from the extension API; the browser and Host refuse busy input before dispatch.
- The Host publishes and serves only the current asset manifest. Browser build mismatch blocks
  requests and subscriptions; an open draft remains visible for manual reload. The previous
  asset cache, retired palette/menu identifiers and redundant literal checks were removed.
- Tool, Thinking, custom-message and checkpoint presentation use one generation. Live and
  History load the same deferred Markdown reader.
- Model discovery resolves extension registrations before constructing its one in-memory preview.
  Validation keeps native provider registration independent of credential availability.
- HTTP bootstrap provides configuration, authority and an address. The addressed subscription
  supplies the only initial transcript projection, then releases events after its sequence cut.
  The snapshot digest and unchanged acknowledgement were removed. A missing addressed session
  settles to an empty view on the same socket, while other read failures retain the current view.
- Terminal controls persist a validated intent and receive the shared operation envelope from a
  single endpoint. The daemon epoch still owns receipt recovery. A retired browser build releases
  its terminal attachment without stopping the process. Browser-issued Host restart uses the same
  receipt shape; only observation of the replacement Host settles restart completion.
- Counted source is 237,736 lines, 14,205 below the handbook baseline and 340 above the previous
  pass. The handbook's full deletion estimate has not been realized.

## Remaining architecture and test replacement

- Complete the shared typed HTTP boundary beyond current operations and native history.
- Finish the shared operation observer and persistence for remaining typed intents, the shared
  draft editor and native action/settings registry.
- Complete shared dock and activity presentation, typed native configuration transactions,
  lifecycle plans and confirmed preference flows. Replace the remaining test matrices with
  the corresponding production owners.
