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
---

# Host and multi-device access

## Objective

Let the same trusted insπre product surface connect from one or more personal client devices to an explicitly selected host machine, while that host remains the sole authority for Pi runtimes, sessions, settings, credentials, projects, authorization, and mutation outcomes.

The planning round must settle the user experience and trust model before selecting transport or writing relay code. Remote access is a new product boundary around the completed local baseline, not a cloud rewrite of it.

## Current state

- Working: planning was selected by the human on 2026-08-09 after the local `v0.1.0` scope closed. The local loopback host already separates an authenticated typed API, bounded live events, replaceable browser projection, and Pi authority; this behavior is the baseline to preserve.
- Working: [[remote-relay-options]] records the current direct-network, Tailscale, WebRTC/TURN, opaque WebSocket relay, client-distribution, and cost evidence without selecting one.
- Working: no relay dependency, remote protocol scaffold, public endpoint, remote-only UI, or partial deployment exists. The current release remains local-only.
- Blocked before implementation: client and host cardinality, trusted remote-client distribution, connection topology, composed-protocol review, control ownership across devices, permission policy, public endpoint and operations authority, and an authorized outside-LAN exercise are unresolved.

## Next actions

- [ ] Define the first release boundary in concrete journeys: first pairing, returning from a paired client, host offline, reconnect during observation, reconnect during mutation, local and remote clients open together, device revocation, lost-device recovery, host switching, and product upgrade. Decide whether the first version is one host with many clients, many hosts per client, LAN-only, outside-LAN, or a deliberately smaller subset.
- [ ] Define the host/client identity and connection state model. The UI must name which machine owns the visible Pi state and distinguish unpaired, pairing, connected, reconnecting, offline, revoked, incompatible-version, read-only, controlling, and outcome-unknown states without turning browser selection into a second runtime authority.
- [ ] Decide multi-device control ownership independently from Pi's one-writer rule. Several browsers can route through one host worker without becoming several Pi writers, but the product must still choose between simultaneous control, one explicit controller lease, or a smaller single-client boundary and define takeover, stale input, dialogs, queues, abort, and attention behavior.
- [ ] Select a trusted client distribution and update authority. Compare an installed PWA, a separately signed or verifiable static artifact, and a native wrapper; the ciphertext relay must not also be able to replace the JavaScript that holds endpoint keys or plaintext.
- [ ] Write the threat model before transport selection: attacker positions, host compromise, relay compromise, stolen or revoked client, pairing interception, replay and reordering, version downgrade, metadata leakage, slow clients, denial of service, and disconnect after a mutation may have committed.
- [ ] Select the smallest topology that satisfies the approved journeys. Compare direct LAN or user-owned VPN access with direct-plus-relay and relay-only paths; keep Express loopback-only and machine connections outbound unless a separately reviewed design proves another boundary.
- [ ] Define one typed operation registry shared by local and remote transports. Never tunnel arbitrary HTTP or expose the local bearer token. Mutations need bounded operation identities, durable deduplication where retry is safe, and conservative reconciliation where acceptance is unknown.
- [ ] Define pairing, permissions, and recovery: high-entropy one-time enrollment, visible host and client fingerprints, protected machine and paired-client stores, read versus control grants, approval and revocation on the host, key rotation, device inventory, immediate disable, and lost-device handling.
- [ ] Define relay and operations authority only if the selected topology needs them: routing metadata, frame and rate limits, bounded backpressure, no plaintext or offline application queue, retention, privacy-safe observability, DNS and TLS lifecycle, abuse controls, hosting budget, incident response, rollback, and named owner.
- [ ] Freeze acceptance before implementation: protocol tamper/MITM/replay/wrong-pair tests, multi-client race tests, revocation and version-skew tests, slow-client bounds, disconnect-during-mutation reconciliation, reconnect snapshots, no-plaintext-storage checks, independent security review, and authorized LAN plus outside-LAN browser exercises where those paths are in scope.
- [ ] Promote only settled standing contracts into living specs, then split implementation into the smallest coherent stages. Until the decisions above close, do not scaffold cryptography, a public relay, or a second browser state path.

## Decisions

- Host access is transport and identity substitution, not cloud synchronization. Canonical Pi data, credentials, settings, project files, authorization, and mutation decisions stay on the selected host by default.
- The completed local UI, message projection, operation semantics, and safety limits are one product surface for both local and remote use; remote mode may add host, trust, permission, and connection state but may not fork conversation behavior.
- Multi-device means personal access unless a later stage explicitly selects multi-user collaboration. Relay-owned conversation state, cloud history, and implicit shared editing remain out of scope.
- An offline client may retain only the versioned application shell needed to explain host state. It does not become transcript authority and does not queue mutations for later replay.
- A relay may know random routing metadata, bounded connection state, and ciphertext only. It does not serve mutable trusted client code, receive the local pairing bearer, or become an application queue.
- Public deployment is a separate externally shared operation and is not authorized by planning or source implementation alone.
- Direct non-loopback host binding, reverse SSH as product architecture, broker-served mutable client code, bearer-token tunneling, and unauthenticated bespoke cryptography are not fallback paths.

## Handoff

Planning is active; implementation is not. Start by settling the first-version host/client cardinality and journeys, then the multi-device control model and trusted client distribution authority. Use [[remote-relay-options]] as comparative evidence, but do not let a transport choice pre-decide the product experience or composed protocol.
