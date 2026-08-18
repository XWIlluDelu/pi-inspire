---
purpose: Optional connection modules add independently managed local ingress paths to one loopback INSΠRE host without becoming host, Pi, session, or browser-authentication authority.
covers:
  - inspire
  - connections/**
  - deploy/systemd/**
  - server/app.ts
  - server/index.ts
  - server/instance-state.*
  - tests/connections/**
  - tests/server/app.test.ts
  - tests/server/instance-state.test.ts
---

# Connection modules

## Goal

Provide detachable local connection modules while retaining one loopback INSΠRE host as the sole Pi, session, credential, and browser-authentication authority.

## Checks

- The core launcher dispatches a named connection module through a checked manifest and does not embed a module's transport configuration, companion-process lifecycle, or server setup.
- A module stores its configuration, control socket, process state, and user-service integration under its own identifier, so stopping or removing it cannot stop, replace, or corrupt the host or another module.
- The host continues to bind only to loopback. Direct loopback browser launches retain one-time token pairing, while an HTTPS request forwarded from a trusted loopback hop strips token URLs without pairing, emits a `Secure` cookie through Pair, and rejects WebSocket query-token authentication.
- The `ssh-reverse` module validates a small non-executable private configuration, establishes only `-R 127.0.0.1:<remote-port>:127.0.0.1:<local-port>`, verifies the SSH process it manages before stopping it, and offers an independently restartable user service.
- Server-side setup remains documentation and static examples. The module never creates remote accounts, keys, DNS records, proxy configuration, or firewall rules.
- The release package contains the dispatcher, connection module, user-service templates, and its setup guide.

## Non-goals

- A connection module is not a second host, a Pi runtime, a session store, or a browser state authority.
- A module does not make server-specific identity, topology, or edge configuration part of the core host contract.
