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

## Verification evidence

- The [platform baseline](../notes/platform-compatibility.md#verified-native-baseline) records
  release and branch CI results. The separate Linux v0.6.5 production-only install exercised
  external Pi startup, pairing, session recovery, PTY I/O and terminal maintenance. Host restart
  preserved the terminal. The managed installation reported Pi 1.5.0 installed and loaded.
- Native Linux checks exercised branch leases, Zsh markers and terminal ownership. Chromium and
  Firefox exercised Activity, Git tabs and retained reading positions against a production Host
  with native session files and an offline fixture provider.

## Remaining acceptance

Check input typography with physical keyboards and input methods on mobile. Installed-window
chrome, badges and background task delivery are tracked in [[follow-notifications-2026-10-22]].
