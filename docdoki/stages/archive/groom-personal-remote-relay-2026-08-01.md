---
scope:
  - inspire
  - connections/**
  - deploy/systemd/**
  - server/**
  - tests/**
  - docs/ssh-reverse.md
  - README.md
  - package.json
  - package-lock.json
---

# SSH reverse connection module

## Objective

Turn the proven local SSH reverse route into one detachable connection module. INSΠRE remains the single loopback Pi/data host; the module owns only its local tunnel lifecycle and recovery, while server setup remains a user-facing example rather than project automation.

## Current state

- Completed: `ssh-reverse` is a checked-in connection module with isolated configuration, state, control socket, lifecycle, and user-service integration.
- Completed: direct loopback pairing remains unchanged; trusted loopback HTTPS forwarding strips token URLs, emits `Secure` Pair cookies, and rejects query-token WebSockets.
- Completed: the local host service and tunnel service were exercised independently; stopping the tunnel left the host running, restart paths restored both loopback listeners, and noninteractive host startup suppresses token-bearing journal output.
- Completed: the release verifier confirms that the module, service templates, and setup guide are packaged.

## Decisions

- A connection module is a detachable local companion process, not a host mode or second Pi runtime.
- Modules may operate concurrently and own only their own configuration, process state, and service unit.
- Core changes are limited to generic proxy/authentication hardening whose direct loopback behavior is unchanged.
- User-specific server identities, keys, hostnames, routes, and edge configuration remain outside the project.
