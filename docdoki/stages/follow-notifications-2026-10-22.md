---
scope:
  - docdoki/specs/{notifications,interface-preferences}.md
  - server/{app,browser-auth,runtime,runtime-external-sessions,runtime-event-sockets,herdr-native-session,external-session,pi-native-actions,task-notifications}.ts
  - docs/{host,extensions}.md
  - docs/examples/session-activity.ts
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

## Objective and authorization

Notify a user who leaves a Pi conversation when work completes or stops with an error.
[[notifications]] holds the decided design. The user approved implementation after the design
review. Production restart remains a separate manual operator action.

## Current state

The first implementation is complete. The Host, device settings, worker display and Web Push
path are connected; Linux Chrome delivery has been exercised with an isolated Host and browser
profile. A user-provided Android screenshot confirms that a manual test notification appears in
the system notification shade. Android background delivery of real task outcomes and tap-to-return,
and iOS device acceptance, remain open. Host activation remains a separate operator action.

### Implemented

- The Host observes run lifecycle independently of pages. It assigns a bounded run/outcome ID,
  preserves failure until settlement, handles unexpected worker exit, and keeps confirmed Stop
  quiet. Page refresh or reconnect no longer owns a task's notification eligibility.
- The native reporter records receiver-bound active runs and recent explicit outcomes. Native
  polling catches a completed short run even when no busy poll occurred; attachment does not replay
  prior history. Herdr errors remain errors. Older reporters or receiver changes without matching
  evidence use neutral **Task ended**, not an invented success.
- Verified browser-key identity routes per-installation settings, subscriptions, live offers and
  acknowledgements. Origin-only legacy credentials and the master token cannot enroll a device.
  Authority-specific private storage holds VAPID keys, devices and bounded 15-minute pending sends.
- The Host offers live delivery first, then pushes after a short unacknowledged grace period.
  Display acknowledgement and foreground suppression retire the fallback. Push retries are bounded;
  invalid subscriptions are removed and delivery failures remain visible until recovery. Settings
  and delivery health travel on the existing device-bound event stream, including during session
  selection. Disabling system alerts cancels their pending sends; re-enabling cannot revive them.
- One Service Worker display path covers live and push delivery, durable cross-window event dedup,
  minimum notification content and normal-authentication session navigation. Cold navigation retains
  its target through pairing and temporary Host unavailability. A newer click supersedes an older
  selection; a deleted target reports the normal selection error instead of silently selecting
  another session. Push never requires an authenticated background fetch to the Host. Expired local
  offers are discarded; received pushes still display under the browser-visible-push contract.
- Settings owns Off / Mark tab / System notification on this installation, permission/enrollment
  health and a transport-aware test. Opening Settings rechecks health. Denial keeps intent without
  claiming enrollment; a changed/lost subscription is repaired or removed without rewriting the
  current preference. Healthy refreshes do not rewrite enrollment. Async enable/disable
  races cannot restore a discarded subscription. Pending page displays and their errors retire
  when the device choice or API connection changes, including while the worker is starting.
  Subscription completion updates transport without restoring intent changed by another window;
  shared choices received during setup are applied when it settles, including on failure.
  Reset affects only this device's alerts.
- Existing paired browsers migrate their prior choice as intent; new browsers start Off.
  Background enrollment still requires a user gesture. Manual-compaction tab attention and
  terminal notifications remain separate.

## Verification

Focused TypeScript and regression checks cover:

- outcome coalescing, failure/retry/cancel semantics, unknown native outcomes, fast native runs,
  receiver isolation and the installed public Pi reporter/action boundary;
- authenticated device scoping, push endpoint validation, private persistence, live acknowledgement,
  restart persistence, expiry, failed delivery recovery and expired subscription removal;
- permission/enable/disable races, worker-readiness settlement after disabling alerts,
  subscription health, actual browser subscription JSON,
  device-local preference/reset behavior, worker dedup, foreground suppression, display rejection,
  click routing and pairing continuation;
- existing Settings loading/navigation, browser icon, connection and native-session behavior.

A production frontend build was served by a separate local Host using real Pi workers and
deterministic local provider fixtures; no model service was needed for those runs. Real Chrome,
its push subscription and the desktop notification service were used rather than a Notification
constructor stub:

- A test notification traversed Host → browser-vendor Web Push → Service Worker. GNOME's
  notification D-Bus interface received the notification.
- With no Inspire page open, normal completion displayed **Task completed**, provider failure
  displayed **Task failed**, and confirmed Stop produced no notification.
- The installed standalone Chrome PWA received completion after reloading during the run.
- Foreground viewing suppressed delivery, including with two open windows.
- Cold session-fragment navigation selected the intended conversation. Worker click routing is
  covered by regression tests; an OS-banner click itself has not been automated.
- Desktop and 390-pixel Settings layouts were inspected; the mobile-width layout did not overflow.
- Closeout verification used the current isolated build with fixture task outcomes and real Chrome:
  two windows shared mode/enrollment changes, switching to Mark tab removed the push subscription,
  and a healthy Settings refresh issued no enrollment write. Re-offering the same outcome after a
  reload and offering an expired local outcome left the existing notification and its timestamp
  unchanged. Cold navigation and a real worker-to-page open message reached the addressed session.
  A fresh test push again reached GNOME. The foreground checks used browser-reported focus;
  Playwright enables focus emulation for its windows.

These checks establish Linux Chrome delivery through the configured network. The exact historical
reason this user's old installation never displayed a banner was not attributed to a single cause.

### Android system display

On 2026-10-23, the user confirmed a real Android system notification with a notification-shade
screenshot. It attributes the notification to Chrome and the deployed Inspire HTTPS origin,
shows **Inspire test notification** with the body **Task alerts are using this notification channel.**,
and displays the time **15:30**. This verifies system-visible delivery of the manual test, beyond
the earlier Settings feedback that the browser accepted the display request.

Background delivery of real task outcomes and tapping a notification to return to its conversation
remain unverified on this device.

## Remaining acceptance and activation

1. On Android, verify real task notifications while the app is backgrounded or the device is locked,
   and tap a notification with no page open to return to the intended conversation.
2. Verify an iOS Home Screen app on an actual device, including background/lock-screen delivery,
   tap-to-return, and foreground coordination under WebKit's visible-push policy.
3. Exercise a native OS notification click on the user's regular desktop installation.
4. Keep remaining Host activation separate from device acceptance; enabling notifications still
   requires a gesture on each installation. Reload updated external native Pi reporters in their
   original idle terminals; restarting the Host does not reload those processes.

No notification inbox, approval workflow, cross-device arbitration or third-party messaging service
was introduced. [The Host guide](../../docs/host.md#task-notifications) documents setup, network
requirements and protected notification state.
