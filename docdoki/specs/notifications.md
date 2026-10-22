---
purpose: Device-local task notifications that report normal completion and error-induced interruption while the user is away, including supported mobile background delivery.
covers:
  - server/{runtime,runtime-events,runtime-external-sessions,herdr-native-session,runtime-event-sockets,browser-auth,preferences,task-notifications}.ts
  - shared/{contracts,assistant-outcome,notifications}.ts
  - docs/examples/session-activity.ts
  - src/{main,browser-auth,notifications}.ts*
  - src/controllers/{runtime-event,preference,connection,session-selection}-controller.ts
  - src/components/Settings.tsx
  - public/{service-worker.js,manifest.webmanifest}
  - server/{app,external-session,pi-native-actions}.ts
  - src/{api,app-state,store}.ts
  - tests/server/{task-notifications,app-auth,runtime-external-sessions,pi-session-activity,herdr-native-actions.integration}.test.ts
  - tests/web/{attention,preferences,task-notification-worker}.test.ts
after: [session-transport,conversation]
progress: in-progress
---

# Task notifications

## Goal

Tell the user when Pi finishes or stops because of an error after they leave the conversation.
Desktop and mobile use the same outcome rules. Notification eligibility must survive page refresh,
background suspension and event-socket reconnection while the Host continues observing the run.

This contract replaces browser-start-event ownership in [[interface-preferences]]. The Host owns
outcomes; each browser installation owns its intent, enrollment and display.
Implementation gaps and verification are in [[follow-notifications-2026-10-22]].

## Outcomes and scope

| Observed result | Notification |
| --- | --- |
| Normal run completion | **Task completed** |
| Error ends the run, including exhausted provider retries or an unexpected worker exit during work | **Task failed** |
| Confirmed explicit cancellation | No task notification |
| External run ended, but the available integration cannot establish its result | **Task ended**; do not claim success |
| Connection lost without evidence that work ended | No invented completion or failure |

Error-induced interruption remains a failure even if a diagnostic contains “abort” or “cancel”.
Use the canonical outcome rules in [[conversation]] and explicit cancellation evidence, not
substring matching or a Stop request's HTTP receipt. A cancellation of the current run does not
erase a later genuine failure. An aborted outcome with insufficient cancellation provenance must
not silently discard an independently established error.

Notifications cover live runs observed by the Host: directly managed Pi and connected native Pi.
Merely discovering a session file or presence record does not start a worker or create a completed
task. Opening old history never produces notifications. Host-owned run observation continues when
the browser leaves; it does not depend on which session another browser selected.

Keep the existing standalone manual-compaction completion/failure behavior, using its own operation
identity. Terminal bell and long-command notifications remain under [[terminal]]; this work does
not add terminal triggers. Waiting-for-input/approval alerts are outside this design.

## Viewing and delivery

- If a focused, visible window on this installation is displaying the owning conversation at
  settlement, consume the outcome without a system notification.
- A different conversation, background application or locked phone is eligible for notification.
- Multiple windows on the same origin/browser profile share one installation and one display
  coordinator. A computer and phone opt in independently; viewing one does not silence the other.
- One outcome has one stable identity across live delivery and push retry. A later run in the same
  conversation has a different identity. Refresh and reconnect do not reset outcome identity.
- Off disables new task delivery on this installation. Mark tab retains the existing title marker.
  System notification also retains that marker when a page is open. Viewing the conversation clears
  the marker without changing an extension-authored title.
- Push has a short expiry and bounded retry. Expired outcomes are not replayed as a notification
  backlog. This is not a notification inbox or a new task-history store.

The service worker owns system-notification display and click handling. Use
`ServiceWorkerRegistration.showNotification()` on supported desktop and mobile installations,
rather than the mobile-incompatible `new Notification()` path.

For an installation with responsive pages, the Host offers the outcome over its authenticated
event connection. A single service-worker coordinator checks same-installation windows and returns
either viewed or displayed. A missing socket alone is not an outcome; a missing delivery
acknowledgment selects the background transport.

For background delivery, the Host sends standard encrypted Web Push to the installation's
subscription. A positive foreground-consumption acknowledgment prevents sending the push in the
first place. Do not send silent pushes and then discard them in a foreground page: WebKit requires
each received push to display a user-visible notification.

Once a push has been sent, it displays even if the user returns during delivery. Stable notification
tags and non-renotifying replacement limit duplicate alerts when local delivery and a retry race.
The coordinator records handled event identities to prevent a late page delivery from showing the
same event again. Transport acceptance, browser display acceptance and human receipt are distinct;
the system must not advertise exactly-once human delivery.

## Settings and activation

Keep the control in **Settings → Behavior**, in the existing field-card style. Use **Task alerts**
with **Off / Mark tab / System notification** and the description:
“Notify when a background task finishes or stops with an error.”
A short “This device” scope label prevents confusion with Host-wide preferences.

Show one contextual status beneath the control, not a separate diagnostics dashboard:

| State | Presentation and action |
| --- | --- |
| Off or Mark tab | No permission prompt |
| System selected, not enrolled | **Enable notifications** |
| Browser permission denied | **Blocked by browser** with concise site-settings guidance |
| Permission granted and page delivery usable, push unavailable | **While Inspire is open**; explain the failed background setup and offer Retry |
| Subscription registered successfully | **Background notifications enabled** |
| iOS browser tab without supported installation | Explain **Add to Home Screen**, then enable from that app |
| Required platform capability missing | Explain the specific unavailable capability; preserve Off/Mark tab |
| Host delivery failure known | Show the current actionable failure near the setting |

Selecting System notification starts enrollment from that user gesture; Enable notifications is
also available for a migrated or interrupted setup. Only a user gesture requests permission or
creates a push subscription. Enabling background delivery briefly explains that it uses the browser's push service; no extra account or hosted Inspire service
is required. Do not infer browser permission from a saved preference, or claim to detect OS
Do Not Disturb/banner settings through an API that does not expose them.

**Send test notification** uses the same active transport and worker display path as a real task,
but deliberately bypasses foreground suppression. It reports actual stages accurately: sent,
display request accepted, or a concrete error. The notification itself is the visual test;
a successful Promise is not labeled “You received it.” An enabled background installation tests
Host-to-push delivery, not merely a local imitation.

Persist intent per Host and origin/browser installation, not in the shared Host preference file.
Keep subscription state and visible permission separate from intent. Check permission on opening
Settings and when the app resumes. Do not repeatedly prompt after denial. An asynchronous permission
or subscription result applies only while that installation's choice is still current. Switching
Off during setup cannot be undone by a late success; failed setup must not overwrite a newer choice.
All windows of the installation observe the same current choice and delivery health. Subscription
reconciliation cannot restore an older choice; a healthy refresh need not rewrite enrollment.

Migration preserves the legacy choice as initial intent. A legacy Desktop selection is not proof
that this installation has enrolled for background push: keep existing granted page delivery while
showing the setup action, and require a gesture before creating its subscription. Off and Mark tab
remain usable without enrollment. New installations default to Off. Reset preferences resets task
alerts only on the current installation; it does not disable another device.

## Host and native-session integration

Introduce one Host-owned outcome coordinator, downstream of authoritative runtime reduction and
independent of browser detail interests. Give each observed run/standalone compaction an identity
and emit its result once. Browser reconnection cannot erase this state. A snapshot can reconcile an
already known run but cannot manufacture an old outcome.

Direct workers supply native settlement, canonical assistant outcomes and unexpected runtime-exit
evidence. Intentional worker maintenance and idle eviction are not task failures.

External native Pi needs more than a polled working/idle bit. Extend the existing optional
public-API activity reporter with process/receiver-bound run identity and terminal-result evidence.
Use public Pi events; do not modify Pi, scrape terminal text or create a second writer. The record
must retain a settlement long enough to observe a short run or a subsequent run starting between
polls. Check receiver identity across reload, session replacement and rebind.

Older activity-only integrations may report a genuine observed end as **Task ended** but must not
label it successful or classify it as a confirmed user cancellation. A poll error or missing
presence record is not proof of worker death. Independently confirmed process exit during an
observed run is failure evidence. These distinctions do not change occupancy or writer-release
rules in [[herdr-enhancement]].

Keep subscription registration and pending delivery state bounded and persistent per Host.
Use stable VAPID keys and a standard Web Push library, not a proprietary Firebase application SDK.
Store pending sends only for their short delivery lifetime; cancel them when the subscription is
disabled or its authority is retired. Restart must not create fresh events from old session status
or lose already queued, still-current notifications.

## Security, content and navigation

- Subscription enrollment, changes, test sends and foreground-consumption acknowledgments require
  authenticated, exact-origin requests. Bind the installation to the existing browser pairing
  identity, not just a caller-supplied installation ID.
- Carry the verified browser-key identity through authenticated request/socket context for
  per-installation routing; origin-only or master-token authentication cannot enroll a device.
  Host credential rotation invalidates subscriptions belonging to the retired authority.
- Push endpoints, encryption keys and VAPID secrets stay in protected Host state and out of logs,
  URLs and project documents. Validate subscription shape and outbound endpoints; disallow local
  network targets, embedded credentials and redirect-based endpoint substitution.
- Push contains the display data needed without contacting the Host: fixed outcome wording,
  cwd-derived project label, opaque event/session identifiers and the same-origin navigation target.
  No prompt, conversation text, model error detail, terminal output or full filesystem path goes to
  the OS surface. Session catalog titles may contain the first prompt and remain excluded.
- Clicking focuses an existing Inspire window when possible or opens its installed-app scope.
  Authenticate normally, then select the target session. Carry an opaque session target through
  initial bootstrap or pairing; never embed a Host/API token in the notification URL.
- If the Host is unavailable, retain the navigation target until connection returns. If the
  session was deleted, explain that without silently opening an unrelated conversation.
  A notification click navigates; it never starts or retries agent work.

## Platform contract

| Platform | Intended experience |
| --- | --- |
| Linux Chrome desktop/PWA | Page and background system notifications; closing the PWA window is supported while Chrome's background runtime remains available |
| Android supported browsers/PWA | Worker-based system notification, including background/lock screen through Web Push |
| iPhone/iPad | Supported Home Screen web app, HTTPS and explicit permission; background/lock-screen Web Push |
| Browser fully exited/force-stopped, OS notification policy or network blocks delivery | Describe the actual limitation; do not claim always-on delivery |

The Host must be running and able to reach the browser's push service. A powered-off Host cannot
report its own failure. Standard push does not require public inbound access to the Host: receiving
the encrypted display payload is separate from opening the private/VPN-hosted conversation.
Remote enrollment and click-through require a trusted HTTPS origin reachable by the device.

## Checks

Exercise normal completion and error-induced interruption from real Host/Pi events, explicit
cancellation, a task spanning page refresh/reconnect, multiple windows, and click-through after
page closure. Verify native terminal outcomes separately from direct workers.

Use focused regression tests for outcome identity/classification, installation ownership,
transport fallback, cancellation/expiry and authenticated navigation. Preserve tests for privacy.
Use a real Linux Chrome installed app to verify both normal and error notifications while another
application is focused. Verify an Android background/locked device and an iOS Home Screen app
before claiming those platforms delivered notifications. Simulated permission or Push events do
not substitute for system delivery.

## Sources

Design follows the delegated notification investigation and design on 2026-10-22.
Implementation and platform verification are recorded in [[follow-notifications-2026-10-22]].

- [MDN: Notification constructor](https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification) — mobile constructor limitation and worker display.
- [MDN: Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) — subscriptions and worker wakeup.
- [WebKit: Web Push for Home Screen apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) — iOS installation, permission and lock-screen behavior.
- [WebKit: Meet Web Push](https://webkit.org/blog/12945/meet-web-push/) — user-visible delivery requirement.
- [web.dev: Push FAQ](https://web.dev/articles/push-notifications-faq) — page closure versus browser-process exit.
