---
scope:
  - src/notifications.ts
  - src/browser-notifications.ts
  - src/visual-preferences.ts
  - src/components/Settings.tsx
  - server/task-notifications.ts
  - public/service-worker.js
  - docs/host.md
---

# Task-alert device acceptance

## Objective

Complete background task-alert acceptance against [[notifications]] without changing native Pi
execution or replacing the separate tab-title/favicon signal.

## Implemented

- The Host classifies task outcomes for built-in and reporter-enabled external Pi sessions.
  Page-independent Web Push delivers them to enrolled installations.
- Device-local Off / Mark tab / System notification intent remains separate from browser permission
  and push enrollment. Settings show the chosen value, effective status and a manual Test action.
- Session grouping replaces one native notification per Pi session. Project grouping combines
  distinct sessions in the same project, counts each once, and links to the latest session.
  Grouping is saved by the Host for each installation; changing it does not request permission
  or enable alerts.
- Host-scoped settings revisions fence late page messages and pushes. A new Host starts with its
  own policy. Outcome ordering, restart persistence, dismissal and viewed-session clearing preserve
  the latest content and unread peers.
- Enrollment repair follows worker and receiver replacement without rewriting saved intent.
  Core navigation and prompt offers do not wait for enrollment.
- Notification click-through reuses a paired page, preserves navigation identity through reload,
  and supports a later prompt in the same Pi.

## Evidence

Linux Chrome native display/click-through, installed-PWA refresh continuity and Android system
display of a manual test are verified. Automated tests cover classification, startup independence,
permission/enrollment races, late Test results after a mode change, expired-subscription retirement,
session/project grouping, deduplication, restart ordering, click ownership and lifecycle event delivery.

A manual Android test covers the receiver path only; background Pi outcomes and same-Pi prompting
still need physical-device acceptance. iOS/iPadOS push has not been physically verified.

## Remaining work

1. On an installed Android receiver, deliver background outcomes, click through, and continue
   prompting in the same Pi, including an offscreen session.
2. On iOS/iPadOS, test permission, badge, click-through and delivery from an
   Add-to-Home-Screen installation.
3. Check installed-window tab/title/badge behavior alongside native notifications and confirm
   status/navigation-bar rendering in light and dark themes.

For external Pi acceptance, activate the reporter through that Pi's own supported reload/restart;
[the extension guide](../../docs/extensions.md#share-sessions-with-terminal-pi) covers installation.
