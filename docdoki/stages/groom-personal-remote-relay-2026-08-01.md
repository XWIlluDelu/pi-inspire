---
scope:
  - relay/**
  - server/**
  - shared/**
  - src/**
  - tests/**
  - package.json
  - package-lock.json
---

# Personal remote relay

## Objective

Use the same session UI against an explicitly paired machine while that machine retains canonical Pi state, credentials, settings, projects, authorization, and mutation decisions.

## Current state

- Working: the local trusted host is loopback-only and separates authenticated requests, bounded live events, and Pi authority.
- Deferred by the human on 2026-08-01: remote access is not selected for the current implementation round. No relay dependency, protocol scaffold, public endpoint, or incomplete remote UI remains in the worktree.
- Blocked before any future implementation: trusted remote-client code distribution, transport and composed-protocol review, public endpoint/operations authority, permission policy, and an authorized outside-LAN exercise are unresolved.
- Working: [[remote-relay-options]] records current transport, security, client-distribution, and cost evidence.

## Next actions after explicit future selection

- [ ] Approve the full threat model and trusted remote-client distribution authority. The ciphertext relay must not also serve mutable browser JavaScript; otherwise it can exfiltrate keys and plaintext before encryption.
- [ ] Approve a transport and independently reviewed authenticated end-to-end protocol with replay/reordering protection, fresh connection keys, strict bounds, and TLS defense in depth. Audited primitives do not by themselves make a composed protocol audited.
- [ ] Approve the external authority before deployment: endpoint, DNS/TLS lifecycle, hosting budget, rate/frame limits, abuse controls, privacy-safe observability, retention, incident response, rollback, and operations owner.
- [ ] Add a separate protected machine identity/paired-browser store. Pair with a high-entropy one-time secret plus visible machine/browser fingerprints; approval and revocation remain local.
- [ ] Keep the machine outbound and Express loopback-only. Carry one typed operation registry through local and remote transports; never tunnel arbitrary HTTP or expose the local bearer token.
- [ ] Keep the relay to random routing metadata, online state, and bounded ciphertext with no offline application queue or client-code hosting.
- [ ] Enforce local read/control permission, immediate disable/revoke, mutation operation IDs, durable deduplication, and conservative unknown outcomes after disconnect.
- [ ] Pass protocol, tamper, MITM, replay, wrong-pair, revocation, slow-client, disconnect-during-mutation, reconnect-snapshot, no-plaintext-storage, independent security review, and authorized outside-LAN staging.

## Decisions

- Remote access is transport substitution, not cloud synchronization. Multi-user collaboration and relay-owned state remain out of scope.
- Public deployment is a separate externally shared operation and is not authorized by a future source-code request unless stated explicitly.
- No direct non-loopback bind, reverse SSH, broker-served client bundle, or unauthenticated bespoke cryptography is an acceptable fallback.

## Handoff

This stage is intentionally dormant. Do not scaffold cryptography or infrastructure until the human selects it and the client-distribution, protocol, and external-authority gates are closed.
