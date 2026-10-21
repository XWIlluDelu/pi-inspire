---
purpose: Independently managed connection modules provide remote ingress to one authenticated loopback Host.
covers:
  - inspire
  - connections/**
  - deploy/systemd/**
  - docs/ssh-reverse.md
  - server/{app,index}.ts
  - server/instance-state.*
  - tests/connections/**
  - tests/server/{app-auth,instance-state}.test.ts
---

# Connection modules

## Responsibilities

The core launcher dispatches named modules through checked manifests. Each module owns its
configuration, control socket, process state and service lifecycle under its own identifier.
Stopping or removing one cannot stop or replace the Host or another module.

The Host remains the Pi, session, credential and browser-authentication authority, listening on
loopback. Remote traffic follows [[host-lifecycle]] authentication. The browser and terminal use
the same ingress and tunnel; a module owns neither PTYs nor a separate terminal port.

## Reverse SSH

The `ssh-reverse` module reads a private, non-executable configuration and establishes only
`-R 127.0.0.1:<remote-port>:127.0.0.1:<local-port>`. It verifies its managed SSH process before
stopping it and offers an independently restartable user service.

- Start, stop, restart and service installation serialize per installation; restart retains the
  same lifecycle lock through stop and start. A failed direct-mode state publication retires only
  the verified launch, and removes its recovery artifacts only after confirmed exit. Uncertain
  identity or cleanup keeps those artifacts instead of stopping an unrelated process.
- Initial connection has a ten-second limit. Three unanswered fifteen-second server-alive probes
  detect an interrupted established connection.
- Diagnostics distinguish Host absence, authentication, server identity, DNS/reachability,
  remote-port rejection and connection loss, retaining SSH's final diagnostic.
- Service commands compare the installed unit with the current module, runtime and installation
  root before control. A stale or foreign unit is not this installation's service.
- Status describes the local listener and managed SSH connection. An operational end-to-end check
  must use a paired client through the public DNS, TLS and proxy path.
- SSH compression stays at its default. Compression on the encrypted hop trades CPU for traffic
  and may duplicate negotiated WebSocket compression.

Server setup is documentation and static examples. The Caddy example compresses browser-facing
responses, marks tunnel-originated 502/503/504 failures, and describes optional UDP 443 for HTTP/3.
The module does not provision remote accounts, keys, DNS, proxies or firewalls.

The release includes the dispatcher, module, service templates and [setup guide](../../docs/ssh-reverse.md).
Package-layout regressions exercise direct and directory-alias CLI entry paths.
[[remote-relay-options]] compares alternatives.
