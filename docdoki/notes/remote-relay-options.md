---
purpose: Current relay transports and hosting costs constrain a future personal remote path that keeps Pi state on the selected machine and relay payloads opaque.
---

# Remote-relay options

The candidate transports were compared against an outbound machine connection, explicit pairing, visible machine identity, end-to-end authenticated encryption, and no canonical conversation or credential store at the relay. TLS to a public relay is necessary but not sufficient because it terminates at that relay; application payloads remain confidential from the relay only when endpoints protect them separately.

## Transport evidence

Tailscale DERP is the security comparator. DERP forwards already encrypted WireGuard packets, and endpoint private keys never leave the devices, so the relay cannot decrypt traffic. It also demonstrates direct connection with encrypted relay fallback. Adopting Tailscale itself would minimize custom network and cryptographic work, but it would make tailnet enrollment rather than inspire pairing the access authority.

WebRTC data channels can carry arbitrary application data and commonly need TURN when direct peer sockets fail. This preserves a direct-or-relayed shape, but a Node host, browser signaling, TURN credentials, and an HTTP/WebSocket-to-data-channel adapter materially widen the implementation.

An opaque WebSocket relay maps most directly onto inspire's existing request/event protocol. Cloudflare Durable Objects can retain hibernating WebSockets without duration charges while idle; the free plan includes 100,000 requests per day, and the paid plan includes one million requests per month before usage charges, with a minimum paid-plan cost. A conventional small relay VM is simpler operationally but stays allocated: Fly.io lists shared 256 MiB machines at roughly $2–3 per month depending on region, free inbound transfer, and public egress from $0.02/GB in North America and Europe to $0.12/GB in Africa and India. Prices are evidence for comparison, not a commitment to either vendor.

## Comparison conclusion

Tailscale provides the smallest custom security surface but substitutes tailnet membership for inspire-managed pairing. WebRTC preserves direct-connect potential but adds signaling, TURN, and transport-adapter complexity. A hibernating opaque WebSocket relay fits the current typed request/event shape and can keep idle cost low, but it still needs a maintained application-layer end-to-end protocol and explicit operations ownership.

A future design must also separate the ciphertext broker from the browser-code trust authority. If the relay serves or can replace the remote JavaScript, it can steal browser keys and plaintext before application encryption; TLS and SRI on relay-controlled HTML do not remove that power. The remote UI therefore needs a separately trusted installed/verifiable artifact or static distribution origin. Audited cryptographic primitives likewise do not make pairing, transcript authentication, framing, reconnect, permission, and unknown-mutation semantics an audited protocol; independent review remains a gate.

[[groom-personal-remote-relay-2026-08-01]] owns these product, threat-model, client-distribution, transport, protocol-review, and deployment gates. The human deferred the feature on 2026-08-01, so this note records evidence rather than an active implementation choice.

Sources:

- [Tailscale DERP servers](https://tailscale.com/docs/reference/derp-servers)
- [WebRTC TURN server](https://webrtc.org/getting-started/turn-server)
- [WebRTC data channels](https://webrtc.org/getting-started/data-channels)
- [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Cloudflare WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Fly.io resource pricing](https://fly.io/docs/about/pricing/)
