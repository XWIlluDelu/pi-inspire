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
- Completed (initial deployment): [[groom-personal-remote-relay-2026-08-01]] now records the explicitly authorized, single-owner personal HTTPS relay. The active remote follow-up is hardening that deployment, not reopening local product scope or treating it as a general multi-device product.

## Completed and selected order

- [x] Priority 0 [[groom-session-continuity-correctness-2026-08-01]].
- [x] [[groom-git-inspection-2026-08-01]] and [[groom-conversation-inspection-2026-08-01]].
- [x] [[groom-daily-use-accelerators-2026-08-01]].
- [x] [[groom-session-branching-2026-08-01]].
- [x] [[groom-session-list-pagination-2026-08-01]].
- [x] [[groom-evidence-gated-maintenance-2026-08-01]] after its compatibility and evaluator gates were selected.
- [x] [[follow-correctness-boundaries-2026-08-02]].
- [x] Priority 1 [[groom-personal-remote-relay-2026-08-01]] — initial single-owner personal HTTPS relay deployed and validated; the selected host remains the Pi and data authority.
- [ ] Priority 1 Harden personal remote access — complete the trusted-proxy, token-URL, and public-server/tunnel operating-boundary hardening in [[groom-personal-remote-relay-2026-08-01]].

## Unscheduled exploration

- [ ] Repository merge governance — decide whether branch protection should require the `quality` GitHub job and pull-request merges. This is shared repository policy, not a source-only change to apply implicitly.
- [ ] Square-style redesign — exploratory only; not selected for implementation. `docs/redesign/` preserves the Trace and Renault references. Any later work begins with fresh product evidence and feedback, not by copying the prototype.

## Decisions

- This stage remains the sole ordering authority. Focused stages contain requirements and evidence so task text is not duplicated here.
- The local `v0.1.0` behavior is the protected product baseline for host access. Personal-remote hardening changes connection and host-selection boundaries around the same browser projection; it does not create a remote-only conversation product or a second state authority.
- The deployed relay remains a personal shared-token boundary. A broader remote-access product is still a separately reviewed security and operations project whose planning must resolve user journeys and control ownership as well as trusted client distribution, transport, protocol review, and external operations authority.
- New public deployment or infrastructure work is never implied by source implementation and still requires exact authorization.

## Handoff

The active product task is to harden the deployed personal relay in [[groom-personal-remote-relay-2026-08-01]]. Begin with its trusted-proxy and token-URL transition plus public-server/tunnel operating boundary; do not broaden it into device identity, multi-user collaboration, or a new relay protocol.
