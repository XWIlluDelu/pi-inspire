---
scope:
  - server/**
  - src/**
  - tests/**
---

# Deep quality hardening

## Objective

Reconcile the current implementation with its correctness and maintainability contracts, fixing confirmed latent bugs and splitting oversized coordination modules only at real ownership boundaries.

## Current state

- **Completed:** Request freshness, filesystem authority, catalog continuity, Pi RPC bounds, accepted-prompt handling, projection ownership, and store rendering subscriptions are hardened with regression coverage.
- **Completed:** Runtime, store, Transcript, navigation, and style responsibilities are split into cohesive modules without introducing parallel state authorities.
- **Completed:** Affected standing specs record the durable contracts. `npm run check`, Chromium browser tests, packaged-release verification, and `git diff --check` pass.

## Decisions

- Post-acceptance projection failure is a recovery fault, not a prompt rejection: stop further writes and expose conflict state while acknowledging the accepted prompt so the browser cannot encourage duplication.
- Split large modules only where the extracted code owns a coherent lifecycle or pure projection; do not extract by line-count quota.

## Handoff

The hardening pass is complete. No live Host restart was performed.
