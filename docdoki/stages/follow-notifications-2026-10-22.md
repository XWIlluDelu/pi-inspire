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

## Verified on devices

Linux Chrome displayed native task notifications and opened the owning conversation on click.
The installed PWA retained the target across refresh. Android displayed a manual Test notification.
[[notifications]] defines outcome classification, grouping, enrollment and delivery.

## Remaining work

1. On an installed Android receiver, deliver background outcomes, click through, and continue
   prompting in the same Pi, including an offscreen session.
2. On iOS/iPadOS, test permission, badge, click-through and delivery from an
   Add-to-Home-Screen installation.
3. Check installed-window tab/title/badge behavior alongside native notifications and confirm
   status/navigation-bar rendering in light and dark themes.

For external Pi acceptance, activate the reporter through that Pi's own supported reload/restart;
[the extension guide](../../docs/extensions.md#share-sessions-with-terminal-pi) covers installation.
