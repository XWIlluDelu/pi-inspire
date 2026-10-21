---
purpose: Compare relay choices with the supported SSH reverse connection.
---

# Remote relay options

The supported connection is a reverse SSH tunnel from the Host to a user-controlled HTTPS edge.
[SSH setup](../../docs/ssh-reverse.md) covers configuration; [[connection-modules]] owns the contract.

| Option | Practical tradeoff |
| --- | --- |
| Loopback | Simple default; browser and Host are on the same machine. |
| Reverse SSH and owned edge | Reuses SSH identity, server policy and logs; requires an HTTPS edge. |
| Tailnet or VPN | Useful when devices already share a private network; reachability belongs to that network. |
| Managed HTTPS tunnel | Convenient routing and certificates, with an external account and traffic-handling provider. |
| Self-hosted relay daemon | More routing options, at the cost of another client/server lifecycle. |

A connection module owns Host-side setup and status. Browser-to-Pi control stays on the authenticated
Host protocol rather than a separate remote-agent protocol. The existing reverse-SSH module can
carry that same browser and terminal transport without a new relay dependency.

Alternative modules remain options, not scheduled work. Compare authentication, disconnect behavior,
diagnostics, WebSocket support and privacy before adding one.
