---
scope:
  - docdoki/specs/{notifications,interface-preferences}.md
  - server/{app,browser-auth,runtime,runtime-external-sessions,runtime-event-sockets,herdr-native-session,external-session,pi-native-actions,task-notifications}.ts
  - docs/{host,extensions}.md
  - extensions/inspire-session-bridge.ts
  - shared/notifications.ts
  - src/{main,api,app-state,store,browser-auth,notifications}.ts*
  - src/controllers/{runtime-event,preference,connection,session-selection}-controller.ts
  - src/components/Settings.tsx
  - src/styles/settings-overlays.css
  - public/service-worker.js
  - tests/server/{task-notifications,app-auth,runtime-external-sessions,pi-session-activity,herdr-native-actions.integration}.test.ts
  - tests/web/{attention,preferences,task-notification-worker}.test.ts
---

# Desktop and mobile task notifications

## Objective

Notify users who leave a Pi conversation when work completes or fails, following [[notifications]].

## Current state

The Host outcome coordinator, per-installation settings, service-worker display and Web Push path
are implemented. Linux Chrome delivery and an Android manual-test notification are verified.
Android real-task background delivery/click-through, iOS acceptance and desktop OS-banner clicking
remain open.

The native reporter records receiver-bound runs and explicit outcomes, including short runs between
polls. Enrollment recovery, device isolation and delivery deduplication follow [[notifications]];
that spec owns the detailed contract. Pending sends are retained for at most 15 minutes.

## Verification

Regression coverage includes:

- run outcomes, explicit cancellation, native receiver identity and public Pi event integration;
- authenticated device scoping, endpoint validation, persistence, expiry and delivery recovery;
- concurrent enrollment/disable changes, subscription renewal, worker deduplication, foreground
  suppression and authenticated click navigation;
- Settings, connection and native-session behavior.

### Linux Chrome delivery

An isolated production build used real Pi workers, deterministic local providers, Chrome Web Push
and GNOME's notification service. Verified outcomes:

- Host → browser-vendor push → service-worker display reached GNOME through its notification
  D-Bus interface. With no page open, completion displayed **Task completed**, provider failure
  displayed **Task failed**, and confirmed Stop stayed quiet.
- An installed PWA received completion after reloading during work. Foreground viewing suppressed
  delivery across two windows. Focus checks used browser-reported focus, including Playwright's
  focus emulation.
- Two browser windows shared mode/enrollment changes; Mark tab removed the push subscription. Healthy Settings
  refreshes issued no enrollment write. Duplicate and expired local offers did not redisplay an
  outcome after reload.
- Cold navigation and worker-to-page click messages reached the intended conversation. Actual
  OS-banner clicking remains an acceptance item.
- Desktop and 390-pixel Settings layouts were inspected without overflow.

### Android system display

A user-provided screenshot on 2026-10-23 confirms **Inspire test notification** in Android's system
notification shade. Real-task background delivery and tapping back into the conversation remain open.

## Remaining acceptance and activation

1. Android: receive real task outcomes while backgrounded or locked, then tap back with no page open.
2. iOS Home Screen app: verify background/lock-screen delivery, tap-to-return and foreground
   coordination under WebKit's visible-push policy.
3. Desktop: click a native OS notification and verify the intended conversation opens.

[Task notifications](../../docs/host.md#task-notifications) documents setup and protected state.
Enabling notifications requires a user gesture on each installation. Updated external Pi reporters load through their
original terminals' reload/restart path, independently of Host restart.
