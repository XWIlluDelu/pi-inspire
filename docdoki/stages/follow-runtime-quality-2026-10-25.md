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

Keep native Pi ownership, asynchronous operation lifetimes and responsive reading behavior
consistent with [[northstar]]. The lasting contracts live in [[notifications]],
[[activity-presentation]], [[terminal]], [[composer]], [[interface-preferences]] and
[[state-ownership]].

## Implemented

- Core navigation starts independently of notification enrollment. Device intent, Host settings,
  receiver replacement and worker delivery have separate ownership boundaries.
- Model catalogs settle their own read state without replacing newer session observations.
  Explicit new-session choices survive refreshes and failed writes remain retryable.
- Pending recovery waits for operation receipts and transcript convergence, including reconnects.
  Recovery completes the originating caller without replaying the submitted mutation.
- Compact activity bounds mounted children while preserving deliberate disclosure, selection and
  reading offsets. Desktop conversation search remains visible; narrow screens use launchers.
- Terminal observer disconnects, failed attaches, refreshes and title updates preserve the active
  control lease and its geometry. Optional notification failures do not kill the daemon.
- Shutdown rejects new work and native-dialog enqueueing. Late observer creation is retired with
  its slot, and extension failures stay inside the owning request or shutdown boundary.
- Native MCP configuration accepts a UTF-8 BOM. Source-build freshness records the revision
  sampled before compilation rather than an edit that arrived during the build.
- Documentation distinguishes durable delivered uploads from unclaimed staging, explains public
  extension-state contracts, and gives first-use, pairing and lifecycle instructions in order.

## Evidence and delivery boundary

Focused unit and Chromium regressions cover these contracts, including delayed replies,
disconnected send/recovery, ownership races, bounded activity, desktop/narrow search and reading
position. Build-source verification changes a source input during a blocked build and confirms
that the resulting artifact remains stale. Local integration also passes typechecking, lint,
formatting, unused-code checks, isolated web/server compilation and the DocDoki privacy check.
Browser color checks compare resolved colors rather than minifier-dependent CSS spelling.
Physical-device evidence is tracked separately.

Version 0.6.5 also passes a local Linux production-only installation check: package contents,
external Pi startup, authenticated readiness/pairing, session recovery, PTY I/O, terminal
maintenance and Host restart preserving the same terminal. The production dependency audit is
clear after compatible request-parser, multipart-upload and schema-validation upgrades; focused
API, configuration, upload and notification regressions pass. Cross-platform evidence is tracked
in [[platform-compatibility]].

The 0.6.5 source, dependencies and browser build are staged in the local installation. The new
entry and retained outgoing assets are served successfully, and the build stamp matches current
inputs. The running Host and terminal daemon have not been restarted. Their activation remains
with the operator; external Pi extensions need their own reload in the original idle process.

## Remaining acceptance

- On Android, verify background task outcomes, click-through and offscreen same-Pi prompting,
  and inspect installed-window status/navigation bars in light and dark modes.
- On iOS/iPadOS, verify Add-to-Home-Screen delivery, permission, badge and click-through.
  [[follow-notifications-2026-10-22]] owns the notification acceptance boundary.
- Android navigation-bar rendering remains browser/OS-owned; the application supplies native
  theme inputs rather than fixed palette-independent color guarantees.

No new product behavior is implied by these outstanding device checks. Persistent-writer
continuity, external Pi ownership and manual service restart remain unchanged.
