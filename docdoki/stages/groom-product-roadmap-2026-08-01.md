---
scope:
  - docdoki/stages/**
---

# Product roadmap

## Objective

Keep one ordered selection surface for product work that is not yet true of the implementation. Focused stages own their acceptance criteria; this stage owns only priority and selection.

## Current state

- Working: the declared local daily-use product scope is complete at the `v0.1.0` baseline. Session continuity, Git and conversation inspection, daily-use accelerators, branching, bounded history, evidence-gated maintenance, release packaging, and the correctness-boundary follow-up are implemented; no known required local feature remains open.
- Maintenance: field-discovered defects, Pi compatibility, security and dependency updates, and evidence-backed local UX corrections remain normal continuing work. This is not a claim that the product can contain no bugs, and speculative local expansion is not a prerequisite for the next product stage.
- Selected for planning by the human on 2026-08-09: [[groom-personal-remote-relay-2026-08-01]] now owns host identity, trusted clients, multi-device journeys, access topology, permissions, reconnect semantics, and the security and operations gates. No remote implementation or deployment is authorized by that planning selection alone.

## Completed and selected order

- [x] Priority 0 [[groom-session-continuity-correctness-2026-08-01]].
- [x] [[groom-git-inspection-2026-08-01]] and [[groom-conversation-inspection-2026-08-01]].
- [x] [[groom-daily-use-accelerators-2026-08-01]].
- [x] [[groom-session-branching-2026-08-01]].
- [x] [[groom-session-list-pagination-2026-08-01]].
- [x] [[groom-evidence-gated-maintenance-2026-08-01]] after its compatibility and evaluator gates were selected.
- [x] [[follow-correctness-boundaries-2026-08-02]].
- [ ] Priority 1 [[groom-personal-remote-relay-2026-08-01]] — product and trust-boundary planning selected; implementation remains gated by its unresolved decisions.

## Decisions

- This stage remains the sole ordering authority. Focused stages contain requirements and evidence so task text is not duplicated here.
- The local `v0.1.0` behavior is the protected product baseline for host access. The next stage substitutes connection and host-selection boundaries around the same browser projection; it does not create a remote-only conversation product or a second state authority.
- Remote access remains a separately reviewed security and operations project. Planning must resolve user journeys and control ownership as well as trusted client distribution, transport, protocol review, and external operations authority.
- Public deployment or infrastructure work is never implied by source implementation and still requires exact authorization.

## Handoff

The selected product stage is [[groom-personal-remote-relay-2026-08-01]]. Begin with its host/client journeys, device cardinality, control-ownership model, and trusted client distribution boundary; do not begin with relay code or cryptographic scaffolding.
