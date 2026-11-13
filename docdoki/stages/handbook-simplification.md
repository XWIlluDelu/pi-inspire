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
  and body section. The title menu still opens branch actions and uses the order from Settings.
  The start and session editors render their stored
  text directly and input history copies text and artifacts on explicit selection. Provider and
  extension prompts share form controls.
- Update probes share a cache owner. Live and saved views share snapshot assembly without
  retaining transcript snapshots in slot metadata. Each socket owns its subscription state, and
  each Pi dialog owns its process and deadline. Deletion reservations share a registry. A lost prompt response
  triggers a bounded read of its original Host receipt. Terminal data and maintenance share one
  wire version. Current credentials, Herdr scopes and attach-control entry paths are in use.
- The owned Pi bridge publishes bounded native checkpoints. The disk reader verifies the file
  independently, including appends from a second Pi. Live adopts finalized native entries from
  checkpoints, preserves unconfirmed output and no longer claims authorship from file appends.
  Reconnecting sockets replay only events newer than their runtime snapshot cut.
- The notification service receives settled outcomes from the runtime and attached receiver,
  without reconstructing runs from browser events.
- Counted source is 240,237 lines, down 11,704 from the handbook baseline and 6,097 from the
  previous pass. The current decrease is 2,767 application/style lines and 3,330 test/support
  lines. Browser verification covers a real 600-turn saved conversation, unloaded search, long
  body sections, restored position, failure retry and Live continuing behind History.
- The full architecture and test replacement remain open. An attached Pi can still queue input
  without an immediate public admission receipt, independently of HTTP response recovery.

## Next actions

1. Move selection and observation fully to the browser, remove eager worker startup on ordinary
   open, and finish the shared read boundary and atomic tail delivery.
2. Move branch routes and actions into the native-turn reader, and share activity/body presentation.
   Consolidate outstanding input recovery, the draft and the operation owners.
3. Complete the shared dock, action/settings registry, native document transactions, lifecycle
   plans, confirmed preferences, and current-build publication gate. Replace the corresponding
   test matrices around the resulting owners.
