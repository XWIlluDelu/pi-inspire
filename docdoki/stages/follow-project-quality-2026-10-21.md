---
scope:
  - server/**
  - shared/**
  - src/**
  - tests/**
  - docdoki/**
---

# Integration quality and activation

## Objective

Integrate the authorized parallel work against [[northstar]], fixing demonstrated
correctness, maintenance and workflow problems. Reuse completed design reviews:
code/spec/test agreement alone does not establish a requirement, and complexity
alone does not establish a defect. [[performance]] owns reproducible measurements.

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

## Integration verification

The integration baseline is shared `auto-dev` commit `010a040`. Parallel contributors
retain their work and identities; only later unshared commits may be regrouped, after
each active contributor freezes. `main`, remote branches and release tags are unchanged.

The first complete integration pass exposed stale adjacent tests: old copy admission,
synchronous auxiliary-index writes, terminal-draft blocking and the removed navigation
tree. Tests now exercise the decided behavior. Native fixtures preserve newly generated
worker control identities while clearing inherited environment; browser resource fixtures
retain the URL constructor. Reporter tests no longer inherit a real Herdr pane identity.
The mobile outside-click listener is installed directly, avoiding a deferred registration
gap. Its regression uses an actual narrow media-query environment.

Linux core/native, launcher and portable checks pass, together with the integrated
desktop/touch browser flows. Typechecking, lint, formatting and unused-code checks pass.
The final candidate includes the unchanged personal Fast UI; its desktop/touch layouts,
three tier states and selective status hiding pass. Service-side release compilation
and isolated compiled-Host startup also pass. History regrouping preserves the tested tree. Prior cross-platform evidence remains the seven
successful jobs in [CI run 39574685523](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39574685523)
for the tagged 0.6.0 source; it is not evidence for the current unshared changes.

## Activation boundary and remaining acceptance

Implementation and integration verification are complete. Local deployment is a separate
operational transaction; its report records the actual running PID and source/frontend/
customization identities. A prepared candidate or successful restart request is not
activation evidence.

- [x] Finish integrated checks and regroup unshared commits with a recoverable old ref.
- [x] Prepare a matching Host/frontend candidate, including local personal customizations,
  and report its commit before activation.
- Activation uses the independent systemd Host-only restart path at an idle boundary.
  A Host-owned Pi must not run a local stop/start sequence that kills its own launcher.
  Do not interrupt in-flight work, restart independent terminals, or enable the daily timer.
- Verify the new Host instance and served frontend separately after activation.
  Existing Pi processes retain their loaded extensions until an explicitly coordinated idle
  reload; replacing files or restarting only the Host does not update external Pi processes.

Physical Android/iOS Web Push acceptance remains in [[follow-notifications-2026-10-22]].
Annotated tag v0.6.0 remains the release marker, without a GitHub Release or uploaded assets;
[[follow-release-0-6-0-2026-10-21]] owns that completed release scope.
