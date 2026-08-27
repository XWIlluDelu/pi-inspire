---
scope:
  - inspire
  - inspire.mjs
  - server/**
  - scripts/**
  - tests/**
  - .github/workflows/ci.yml
---

# Cross-platform Host lifecycle

## Objective

Make the standalone INSΠRE Host and packaged CLI work on Linux, macOS, and Windows without weakening the existing local authority, process ownership, or filesystem safety boundaries.

## Current state

- **Completed:** npm uses the canonical JavaScript CLI while the source-checkout shell wrapper remains available. Native per-user paths, browser opening, npm invocation, instance lifecycle, diagnostic storage, preferences, and desktop Trash behavior cover all three systems.
- **Completed:** Linux retains kernel `flock`; macOS and Windows use a process-birth-bound Lamport bakery. Preferences preserve the established `.flock` identity across Linux upgrades.
- **Completed:** Pi, Git, and verification subprocesses use one process-tree termination authority. Normal Host shutdown is authenticated; exact OS process identity gates any signal fallback.
- **Completed:** CI runs the complete static/unit/lifecycle and Chromium gates on Linux, macOS, and Windows, with packaged release verification on all three after a main-branch push. The optional `ssh-reverse` connection module remains Linux-only.
- **Verified locally:** `npm run check` passes 1,087 tests including launcher and portable suites; Chromium passes 20 browser scenarios; `npm run release:verify` validates the installed npm shim, mock lifecycle, and real Pi startup; `git diff --check` passes.

## Decisions

- Cross-platform support belongs to the core Host and release package; platform-specific connection modules retain their own narrower support contracts.
- One Chromium product gate per supported Host OS tests the intended portability boundary. Browser-engine expansion is independent work, not a substitute for operating-system lifecycle evidence.
- Unsupported or unverifiable process ownership fails closed rather than signaling by PID alone.

## Handoff

The implementation is complete. Remote operating-system CI remains the final independent witness after push. The live Host was not restarted.
