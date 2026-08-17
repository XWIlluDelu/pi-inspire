---
scope:
  - relay/**
  - server/**
  - shared/**
  - src/**
  - public/**
  - scripts/**
  - tests/**
  - inspire
  - package.json
  - package-lock.json
  - README.md
---

# Host and multi-device access

## Objective

Maintain the deployed, explicitly authorized single-owner HTTPS relay for one trusted Inspire host and harden its operational boundary without changing that host's authority for Pi runtimes, sessions, settings, credentials, projects, authorization, or mutation outcomes.

This does not select a general multi-device, multi-user, opaque-relay, or cloud-synchronization product. Those larger journeys remain planning work.

## Current state

- Completed (initial deployment): the local loopback host remains the Pi/data authority, and its typed API, bounded live events, replaceable browser projection, and one-writer behavior are unchanged.
- Completed (initial deployment): the authorized route is `browser -> HTTPS Caddy on a public server -> 127.0.0.1:14587 -> restricted SSH reverse tunnel -> host 127.0.0.1:4587`. Caddy is the only public edge; both tunnel endpoints are loopback-bound.
- Completed (initial deployment): browser pairing over that route was exercised through HTTPS and WebSocket using a 64-character (384-bit) generated token, `HttpOnly; SameSite=Strict; Secure` cookie, exact-origin checks, HSTS, and no Caddy access log for this route.
- Working: the current host still runs in ordinary loopback mode, so Caddy appends `Secure` to pairing cookies at the edge. The application supports `INSPIRE_TRUST_PROXY=loopback` and `INSPIRE_ALLOW_TOKEN_URL_PAIRING=0`, but this deployment has not yet been restarted with those hardening settings.
- Working: [[remote-relay-options]] remains comparative evidence for a future general solution; no opaque relay, remote-only browser path, or cloud state exists.
- Deferred: client/device inventory, revocation, read/control permissions, simultaneous-control policy, trustworthy remote client distribution, and general relay protocol are unresolved because they are outside this single shared-token personal deployment.

## Next actions

- [x] Deploy and validate the initial personal HTTPS relay while retaining a loopback-only host and public-edge TLS termination.
- [ ] Harden the personal remote scheme during a controlled maintenance window: start the host with `INSPIRE_TRUST_PROXY=loopback` and `INSPIRE_ALLOW_TOKEN_URL_PAIRING=0`, verify HTTPS pairing and WebSocket operation, verify token URLs are stripped without pairing, then remove the Caddy cookie normalization after the host emits one `Secure` cookie itself.
- [ ] Verify the public-server and tunnel operating boundary: Caddy remains the only public edge for this service, the reverse-tunnel listener remains loopback-only, the SSH key remains restricted to that listener, and the restart/recovery path preserves those conditions.
- [ ] Rotate the shared token if it is exposed; do not treat it as a device identity or authorization system.
- [ ] Before any general remote-product work, define concrete journeys, client/host cardinality, identity, device revocation, read/control grants, and simultaneous-control behavior independently from Pi's one-writer rule.
- [ ] Select a trusted client distribution and relay topology only after its threat model covers relay compromise, stolen client, pairing/replay, version downgrade, metadata, slow-client limits, and disconnect-after-mutation reconciliation.

## Decisions

- Host access is transport and identity substitution, not cloud synchronization. Canonical Pi data, credentials, settings, project files, authorization, and mutation decisions stay on the selected host.
- The authorized first boundary is one owner sharing a high-entropy host token across personally trusted browsers. It has no device inventory, per-device revocation, read/control role, or multi-user claim.
- The host binds only to loopback. For this service, a public server exposes only Caddy HTTPS; its reverse-tunnel listener is loopback-bound and authenticated by a restricted SSH key permitted to listen only on that port.
- The public edge preserves exact-origin pairing, HSTS, `HttpOnly; SameSite=Strict; Secure` cookies, and avoids route access logs. It is a trusted TLS terminator, not an opaque ciphertext relay.
- Caddy cookie normalization is a temporary deployment bridge, not a substitute for application trusted-proxy mode. The hardening step must retire it only after the host receives forwarded protocol from the loopback tunnel and disables token-URL pairing.
- The completed local UI, message projection, operation semantics, and safety limits remain one product surface; no second browser state path or relay-owned conversation state exists.
- Direct non-loopback host binding, cloud transcript authority, implicit shared editing, broker-served mutable client code, and unauthenticated bespoke cryptography remain out of scope.

## Handoff

The initial personal HTTPS relay is complete. Continue with the first unchecked hardening action; preserve the loopback-only host and the current single-owner boundary rather than generalizing this shared-token proxy into a multi-device product. Use [[remote-relay-options]] only as comparative evidence for a later, separately designed remote-access product.
