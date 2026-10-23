---
scope:
  - server/**
  - shared/**
  - src/**
  - tests/**
  - docdoki/**
---

# Main integration quality

## Objective

Review and integrate the `auto-dev` changes newer than the current `main` tree against
[[northstar]]. Keep changes that solve material correctness, maintenance or workflow problems,
and organize the result into coherent commits on `main`. [[performance]] owns reproducible
measurements.

## Implemented decisions

- Independent Fork/Clone captures a source view and target, not the latest whole-tree
  revision or control of the source writer. Project discovery and history-source failures
  remain visible without becoming execution or readable-history gates.
- Global preferences and model settings remain repairable despite unrelated invalid
  fields, discovery failures or unreadable project settings. MCP supports reversible
  draft rules and explicit inspection/editing of saved connection values.
- Terminal and Host restart recovery distinguish confirmed outcomes from local tracking
  failures. Users can explicitly end tracking without replaying or cancelling remote work.
- Owned partial persistence waits for completion rather than stopping Pi on a two-second
  observation deadline. Confirmed file replacement, truncation and writer conflicts still
  fence execution.
- Automatic attachment cleanup covers unclaimed staging only. Delivered or possibly
  delivered files remain assets; reference scanning, root registration, volume continuity
  and trust migration are retired. Search owns documented query semantics rather than
  importing Pi's private interactive matcher.
- Export work outlives its dialog without duplicate downloads. UI consolidation removes
  the duplicate navigation file tree, preserves Files, and improves notifications,
  short workbenches and Models/MCP controls. Relevant specs own the lasting contracts.

## Integration scope

The starting `origin/main` commit is `b259032d`. Its tree equals `auto-dev` commit `010a0402`,
despite their different histories. The candidate source is `62240169`: 55 later `auto-dev`
commits. Tree and behavior differences therefore define this integration, rather than the
unrelated commit ancestry. Development history stays on `auto-dev`; reviewed outcomes become
new commits on `main`.

The candidate also includes configurable GUI adapters, source-preserving user-input summaries,
automatic recovery of read operations and unsent uploads, and viewed external-session recovery.
Their contracts remain in the relevant specs. Review fixes belong with the result they repair,
including its tests and documentation.

## Review and verification

Review preserved the Pi-owned execution boundary and removed obsolete deployment history,
unused UI exports and assertions tied to superseded recovery behavior. External-session recovery
now keeps its read-only boundary until writer startup completes, fences retired connections,
and reports source-attestation failures. Replaced history invalidates its reading view even when
admission stops before Pi starts. Once Pi startup has begun, failure requires an explicit retry
rather than automatically repeating extension startup hooks. Adapter controls accept Pi's
registered command names, including collision suffixes. Compact touch notices use consistent
control alignment.

The Linux candidate passes formatting, lint, typechecking, unused-code checks, web and server
release compilation, 41 portable tests, and the frontend/server/native and launcher regression
suites with affected failures rechecked. The selected 95 Chromium scenarios pass after correcting
obsolete expectations and the touch notice defect; they cover desktop/touch settings, History,
session actions, attachments, reading/search and feedback. Two initial browser timing failures
passed focused reruns without implementation changes. DocDoki's private-boundary check passes.

These checks cover the integration candidate, not macOS/Windows execution or physical-device
notification delivery. Each reorganized implementation commit also passes typechecking.

The tagged 0.6.0 source has historical cross-platform evidence in
[CI run 39574685523](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39574685523).
[[follow-release-0-6-0-2026-10-21]] owns that release record.

## Delivery

The reviewed changes are organized by outcome: repairable configuration and session actions;
native session ownership; durable attachments; source-preserving history; managed lifecycle;
shared responsive UI; configurable adapters; read/upload recovery; notifications; and consolidated
documentation. Corrections and their regression tests belong to the outcome they protect.

Physical Android/iOS Web Push acceptance remains in [[follow-notifications-2026-10-22]].
Publishing source does not activate a running Host or reload external Pi processes;
[Host operations](../../docs/host.md) and [extension activation](../../docs/extensions.md#show-external-session-activity)
describe those separate operations.
