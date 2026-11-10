---
scope:
  - package*.json
  - src/**
  - server/**
  - tests/**
  - scripts/**
  - docs/**
---

# Runtime quality and device acceptance

## Objective

Maintain native Pi ownership, recoverable browser projections, and the platform checks needed for
current work. [[session-persistence]] owns worker and write authority, [[session-transport]] owns
reconnect and Pending recovery, and [[host-lifecycle]] and [[terminal]] own the two service
lifecycles. [[state-ownership]] records the shared ownership patterns. [[dependency-boundaries]]
covers installed Pi discovery, and [[platform-compatibility]] holds the platform baseline.

## Verification evidence

- The [verified native baseline](../notes/platform-compatibility.md#verified-native-baseline)
  records the separate cross-platform results for the release tag and later review.
- The local v0.6.5 production-only install verified external Pi startup, pairing, session recovery,
  PTY I/O, terminal maintenance, and Host restart with the same terminal. The production audit
  reported zero advisories at that time. The managed-installation rollout verified installed and
  loaded Pi 1.5.0 via authenticated reads and retained the terminal daemon.
- Local Linux checks covered native persistence witnesses, startup and retirement, branch leases,
  bounded Activity mounts, Zsh marker round-trips, and terminal ownership. The delayed-presentation,
  mixed-append and managed-Pi cases detected regressions against the prior implementation.
- Browser acceptance uses the production Host and native session files with an offline fixture
  provider. Chromium and Firefox exercised Activity, Git tabs and retained reading positions.
  Local WebKit runs required the unavailable system library `libicudata.so.76`.
- Tests use a per-run XDG runtime directory. Launcher tests build in a disposable copy. On the
  32-core Linux host, half the workers held the suite at 41–43 seconds and reduced queue pressure
  that had caused failures at short wait deadlines.

## Remaining acceptance

- Herdr Host-only restart still needs a durable worker ownership handoff. A simulated failure to
  remove the old registry lease left detach reported as successful, and startup recovery would
  still stop that scope. Recovery must distinguish a released worker from an owned worker even
  when the old Host exits partway through the handoff.

[[follow-notifications-2026-10-22]] owns Android and iOS/iPadOS push and same-Pi click-through
acceptance. Check input typography and native installed-window chrome on the physical platforms,
including Android status/navigation bars in light and dark mode. Browser viewport emulation
exercises layout and input handling.
