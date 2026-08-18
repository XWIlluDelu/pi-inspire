---
scope:
  - .github/workflows/ci.yml
  - package.json
  - scripts/**
  - server/**
  - shared/**
  - src/**
  - tests/**
---

# Audit follow-up

## Objective

Reconcile the external audit findings with the implementation, repair confirmed
correctness gaps, and complete the evidenced behavior-preserving decomposition
without creating a second browser store or Pi runtime authority.

## Current state

- Completed: identity-bound deletion and resource serving, resource transport
  ownership, curated session navigation, earlier-branch context, and bounded
  queue presentation were repaired and characterized.
- Completed: `AppStore` and `RuntimeController` remain facades over bounded
  browser and runtime collaborators; none owns a parallel session catalog,
  projection, event bus, or persistence lane.
- Completed: format/lint/import-boundary coverage, packaged-release validation,
  size evidence, and focused Chromium witnesses were added. Their standing
  product contracts live in [[workbench]], [[resource-preview]],
  [[session-continuity]], [[composer]], and [[pi-integration]].

## Decisions

- One authority does not require one implementation file. Bounded collaborators
  may operate through a facade, but may not retain parallel canonical state.
- Static font-candidate inventory is not browser font-transfer evidence; package
  and observed-network measurements remain distinct.
- Session deletion remains an independent identity-bound adapter, not a future
  extraction target.
