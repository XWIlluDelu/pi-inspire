---
scope:
  - inspire
  - server/**
  - shared/**
  - src/**
  - tests/**
  - docdoki/specs/**
---

# Correctness boundaries follow-up

## Objective

Repair twelve confirmed lifecycle, filesystem, launcher, and browser-ownership defects without adding parallel authorities, compatibility forks, or retry-based concealment.

## Result

Completed on 2026-08-02.

- Workspace operations now share the Pi slot's canonical physical root; writer conflicts remain sticky; fork buffering remains bounded through atomic destination attach; and response-bearing Pi 0.83 `session_start` UI fails promptly with an attributable unsupported-boundary error instead of hanging.
- Host and browser share one queued/busy authority. Selection, rename, and prompt completion are bound to their initiating operation and session, so stale work cannot lock or mutate a newer visible session.
- Session deletion quarantines and verifies the inspected inode before any path-based Trash/unlink, while resource previews derive current size and truncation from the content transfer rather than stale resolve metadata.
- Restart retains one launcher lock across stop/start, including the no-instance path; the narrow-screen navigation drawer starts below the topbar so its sole toggle remains operable.

The governing contracts were routed to `session-continuity`, `pi-integration`, `composer`, `resource-preview`, `workbench`, and `design-system`.

## Validation

- Focused regressions cover every reported defect, including installed Pi startup UI, late fork overflow, symlink retargeting, deletion replacement, transfer grow/shrink, delayed browser operations, launcher restart, and queued controls.
- Final `npm run check`: 49 files and 548 tests passed, including TypeScript.
- Final production build passed; only the pre-existing large-chunk warning remains.
- Isolated launcher acceptance passed `restart → status → stop` with no prior instance.
- Chromium at 390×844 verified mouse, touch, and keyboard navigation closure, preserved focus/content, no horizontal overflow, and zero console/page errors.
- DocDoki privacy and diff checks passed at closure.

## Decisions

- Pi and Pi TUI remain on the latest npm release, `0.83.0`; Inspire does not patch or vendor Pi RPC to work around its startup stdin ordering.
- Persistence-capable, destructive, and fork-identity failures do not auto-retry.
- Same-UID filesystem races are correctness boundaries without inflated remote-security claims; an unverified quarantine is preserved rather than destructively guessed back into place.
