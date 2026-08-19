---
scope:
  - deploy/systemd/**
  - inspire
  - server/**
  - tests/server/**
  - tests/launcher.test.ts
  - docdoki/specs/pi-integration.md
---

# Idle maintenance restart

## Objective

Apply already installed Pi or INSΠRE updates only at 04:00 after the host has
atomically confirmed all runtime work is idle. Never fetch updates, force an
active worker to stop, or restart the live service during implementation.

## Outcome

- `install-host` writes the host, maintenance service, and daily timer;
  `enable-host` and `disable-host` manage the host and timer together.
- The timer compares only already installed Pi and INSΠRE identities, obtains an
  authenticated 30-second runtime lease only after all work is idle, then asks
  systemd to restart the matching host unit.
- Dirty, unavailable, busy, or legacy hosts are skipped without force or
  same-day retry.
- The timer was installed and enabled for the active checkout; its first
  scheduled run is 04:00 local time. The currently running host was not
  restarted. It will use this new admission endpoint after the next separately
  authorized host restart; before then, the timer safely skips the legacy host.

## Decisions

- Update acquisition remains explicit.
- A clean source revision or installed package version identifies an INSΠRE
  update; Pi is identified by its installed external package version.
