---
scope:
  - README.md
  - docs/tool-presentations.md
  - docdoki/notes/performance-evidence.md
  - docdoki/specs/conversation.md
  - docdoki/specs/pi-integration.md
  - server/**
  - src/**
  - tests/**
---

# Legacy review reconciliation

## Objective

Reconcile an older external review against the current implementation, repair
only findings that still reproduce, and reject recommendations that conflict
with the current product contract.

## Current state

- Completed: live reducer failures rebuild from an authoritative snapshot, while
  cumulative assistant updates are rendered at an adaptive bounded cadence
  without reordering lifecycle events.
- Completed: browser-bound runtime events have an encoded-size ceiling; POSIX
  Pi workers own process groups so child tools cannot outlive worker teardown.
- Completed: project indexing uses structured Git output, supports linked
  worktrees, validates limits and UTF-8, and revalidates selected paths at send
  time. Project-file context is JSON-framed rather than line-list interpolation.
- Completed: preference mutations serialize across Host processes; attachment
  cleanup is awaited; browser status requests cannot overwrite newer results;
  and access cookies are scoped to one checkout/origin identity.
- Completed: capability-discovery failures now enter metadata-only diagnostics,
  route-shape fallthrough returns JSON 404 responses, extension fallback and
  Thinking provenance are documented, and historical performance witnesses
  identify the measured build.
- Already satisfied before this pass: bounded RPC input and session projection,
  lease-aware worker eviction, resource error presentation, startup UI request
  rejection, decoded route matching, bounded pending lists, and malformed
  extension-presentation fallback.

## Decisions

- INSΠRE formally supports the latest Pi release. Older releases may work but do
  not justify compatibility branches, protocol-generation machinery, or a
  maintained version matrix; see [[pi-integration]].
- External review severity is not acceptance evidence. Each observation is
  checked against the current owner and contract before it changes code.
- Performance claims require a current, reproducible witness or explicit
  historical build identity; elapsed time alone is not a memory-complexity
  measurement.
