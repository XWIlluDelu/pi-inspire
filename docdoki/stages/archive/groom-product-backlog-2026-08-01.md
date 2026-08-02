---
scope:
  - server/**
  - shared/**
  - src/**
  - tests/**
  - package.json
  - package-lock.json
---

# Product backlog grooming

## Objective

Consolidate product work that is not yet true of the implementation, retain reusable evidence, and replace a mixed backlog with an ordered roadmap plus focused, falsifiable implementation stages.

## Outcome

- The former enhancement-proposal and open code-review notes were removed after current contracts, reference evidence, performance gates, and retained work were routed to their proper authorities.
- Current session-scale measurements, Pi dependency compatibility and advisory results, and remote-relay security/cost comparisons now live in [[session-scale]], [[dependency-boundaries]], and [[remote-relay-options]].
- [[groom-product-roadmap-2026-08-01]] is the sole ordering and selection authority. Focused stages own session-continuity correctness, Git inspection, conversation inspection, daily-use accelerators, session branching, session-list pagination, personal remote relay, and evidence-gated maintenance.
- The living specs and spec abstract were groomed back to standing implemented contracts: future remote access and transient decision history no longer masquerade as current specification.
- No implementation item was selected and no source code or dependency was changed in this grooming round.

## Decisions

- Correctness and one-writer session continuity remain Priority 0. No inspection or accelerator work should introduce a second session projection before that authority is fixed.
- Unselected product work belongs in focused stages, not notes or timeless specs. The roadmap carries only ordering so acceptance text has one owner.
- Pi 0.83.0 is compatible with the current test/build surface but does not retire the remaining high `brace-expansion` advisory, so the project stays pinned pending an eligible release.
- Remote relay remains a later externally operated security project; local protocol work alone cannot satisfy deployment, pairing, and end-to-end acceptance.
