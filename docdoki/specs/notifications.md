---
purpose: Device-local task notifications that report normal completion and error-induced interruption while the user is away, including supported mobile background delivery.
covers:
  - server/{runtime,runtime-events,runtime-external-sessions,herdr-native-session,runtime-event-sockets,session-catalog,session-metadata,mock,browser-auth,preferences,task-notifications}.ts
  - shared/{contracts,assistant-outcome,notifications}.ts
  - extensions/inspire-session-bridge.ts
  - src/{main,browser-auth,browser-notifications,notifications}.ts*
  - src/controllers/{runtime-event,preference,connection,session-selection}-controller.ts
  - src/components/Settings.tsx
  - public/{service-worker.js,manifest.webmanifest}
  - server/{app,external-session,pi-native-actions}.ts
  - src/{api,app-state,store}.ts
  - tests/server/{task-notifications,session-catalog,session-metadata,app-auth,runtime-external-sessions,pi-session-activity,herdr-native-actions.integration}.test.ts
  - tests/web/{attention,preferences,task-notification-worker}.test.ts
after: [session-transport,conversation]
progress: in-progress
---

# Task notifications

## Goal

Notify users when Pi finishes or fails after they leave the conversation. The Host owns run
outcomes across page refresh, suspension and reconnection; each browser installation owns its
notification choice, enrollment and display. Device acceptance is tracked in
[[follow-notifications-2026-10-22]].

## Outcomes and scope

| Observed result | Notification |
| --- | --- |
| Normal completion | **Task completed** |
| Error ends work, including exhausted retries or unexpected worker exit | **Task failed** |
| Confirmed explicit cancellation | None |
| Observed external run ends without a known result | **Task ended** |
| Connection lost without evidence that work ended | None |

Use canonical outcomes from [[conversation]] and explicit cancellation evidence. Error text
containing “abort” or “cancel”, or a Stop receipt alone, cannot classify the result. Cancellation
of one run cannot erase a later failure; an unattributed aborted outcome cannot erase an
independently established error.

Observe directly managed and connected native Pi runs independently of browser selection.
Opening saved history or discovering a presence record does not create an outcome or start work.
Standalone manual compaction retains its own operation identity. Terminal alerts follow
[[terminal]]; they share browser permission handling but keep separate delivery intent.
Waiting-for-input alerts are outside this design.

## Viewing and delivery

- A focused, visible window displaying the owning conversation at settlement consumes the outcome
  without a system notification and closes older task notifications for that session. Another
  conversation, a background app or a locked phone is eligible.
- Windows on one origin/browser profile share an installation and display coordinator. Devices
  opt in independently; viewing on one device does not silence another.
- **Off** disables delivery. **Mark tab** sets the existing title marker. **System notification**
  also marks an open page. Viewing clears the marker while preserving extension-authored titles.
- Each outcome keeps one identity across live delivery, reconnect and retry; later runs get new
  identities. This installation chooses **Session** (the default) or **Project** display slots.
  A new result replaces the group's older notification. Session slots use stable session IDs;
  project slots use Host-scoped opaque cwd identities, never possibly colliding display labels.
  Missing project metadata falls back to a separate session slot while retaining any confirmed binding.
- Ordinary titles use `Task completed · <session name>`, `Task failed · <session name>` or
  `Task ended · <session name>`. Use the latest saved name at settlement, normalize whitespace,
  and fall back to `Unnamed session`, never the first prompt. Keep the project label in the body.
  Renaming retains the same display slot; system layout handles wrapping and truncation.
  A project slot containing one notified session uses that session's name; more than one uses
  `<n> sessions`. Count distinct represented sessions, not runs or every saved session in the project.
  Outcome wording and click-through follow the latest represented result. Viewing a new result removes
  only its session from the visible project group, preserving other unread members. Dismissal/click
  clears the group's cycle: the next fresh notification starts counting again.
- A new result remains eligible to alert; duplicate delivery and delayed older results do not
  re-alert. Devices and OS policy still control banners and sounds. Test notifications keep a
  separate identity and cannot replace task results.
- Pending sends retain only the newest result per device/session, expire and use bounded retries.
  Project aggregation happens in the worker, which knows what is still visible: push payloads do not
  carry an ever-growing member list or let Host backlog counts resurrect dismissed sessions.

The service worker owns display through `ServiceWorkerRegistration.showNotification()` and handles
clicks. This supports mobile installations where the `Notification` constructor is unavailable.
The Host first offers an outcome over the authenticated event connection. The worker checks all
same-installation windows and acknowledges viewing or display. Without acknowledgement, the Host
uses encrypted Web Push.

A foreground acknowledgement prevents push dispatch. Once sent, a push must display even if the
user returns: WebKit requires received pushes to produce a visible notification. Retain the latest
handled result per session/project across worker restarts, including results consumed by foreground viewing.
Visible project notifications retain their represented sessions across worker restarts. A stale unseen
member can update the count silently without replacing newer result content; mandatory push repaints
after dismissal do not count already-handled sessions as fresh members.
Order results by Host settlement time, distinguishing settlements within one clock tick. A delayed
local offer is acknowledged without display; a delayed or duplicate push silently redraws the latest
known result rather than restoring older content. Stable tags and handled outcome identities keep
display replacement separate from delivery deduplication. Retire that session's legacy per-run slots
only after its replacement displays successfully. Grouping policy is Host/installation-owned and
revisioned: late pushes cannot revert a newer choice, and a newly paired Host can restore its own
defaults. Changing grouping clears existing task notifications without replaying old results or
clearing test notifications. Report transport acceptance and display acceptance separately from human receipt.

## Settings and activation

**Settings → Behavior → Task alerts** offers **Off / Mark tab / System notification**, with
“This device” scope and a description of background completion/error alerts. Show one contextual
status beneath the control:

| State | Presentation and action |
| --- | --- |
| Off or Mark tab | No permission prompt |
| System selected, not enrolled | **Enable notifications** |
| Permission denied | **Blocked by browser**, with site-settings guidance |
| Page delivery works but push setup failed | **While Inspire is open**, with the error and Retry |
| Subscription registered | **Background notifications enabled** |
| iOS installation required | **Add to Home Screen**, then enable from that app |
| Required capability unavailable | Explain it; retain Off/Mark tab |
| Host delivery failed | Show the actionable error |

A neighboring **Notification grouping** field offers **Session / Project**, with this-device scope
and a warning that changing it clears existing task notifications. Its field-owned save, busy/error
feedback and retry are independent of alert mode, permission and enrollment. Reset restores Session
on this installation. Existing installations without a choice retain Session.

Only a user gesture requests permission or creates a subscription. Selecting System notification
starts enrollment from that gesture; Enable supports migrated or interrupted enrollment. Explain that push
uses the browser's service without requiring another account. Permission is observed from the
browser, independently of saved intent; OS notification policy is outside that observation. Do not
repeatedly prompt after denial.

**Send test notification** uses the active delivery transport and worker display path, bypasses
foreground suppression, and reports the actual accepted stage or error. An enrolled installation
tests Host-to-push delivery.

### Installation state

Persist the choice per Host and origin/browser installation. All its windows share current intent
and delivery health. Recheck on initialization, opening Settings and app resume. Reconcile an
existing subscription whose Host registration failed without requesting permission again; healthy
refreshes need not rewrite enrollment. An endpoint rejected as expired stays retired until explicit
Enable replaces the browser subscription.

Async permission, subscription and display results belong to the current choice and API owner.
Late completion cannot re-enable alerts, overwrite another window's choice or restore stale errors.
Disabling alerts cancels pending sends; re-enabling does not revive them. Reset affects this device
only. New installations default to Off. Migration preserves the old choice and any usable page
delivery while showing enrollment as a separate step.

## Host and native-session integration

The Host's outcome coordinator follows authoritative runtime reduction and retains each observed
run or manual-compaction result independently of page interests. Snapshots reconcile known runs;
they do not create historical outcomes. Direct workers supply settlement, assistant outcomes and
unexpected-exit evidence. Maintenance and idle eviction are not task failures.

The optional native activity reporter uses public Pi events with process/receiver-bound run and
outcome identities. Retain settled outcomes long enough to observe short runs or a subsequent run
starting between polls, and check receiver identity across reload, replacement and rebind. An
activity-only reporter can establish **Task ended**; classifying success or cancellation requires
outcome evidence. Poll failures or missing presence records establish neither death nor release.
Independently confirmed process exit during an observed run is failure evidence; ownership follows
[[herdr-enhancement]].

Bound and persist subscriptions and short-lived pending sends per Host with stable VAPID keys and
standard Web Push. Restart preserves still-current queued sends without generating new historical outcomes.
Disabling a subscription or retiring its authority cancels its pending sends.

## Security, content and navigation

- Enrollment, settings changes, test sends and acknowledgements require authenticated exact-origin
  requests bound to the verified browser pairing key. Caller-supplied IDs, origin-only credentials
  and master tokens cannot enroll a device. Host credential rotation invalidates old subscriptions.
- Protect endpoints, encryption keys and VAPID secrets in Host storage; keep them out of logs, URLs
  and project documents. Validate subscription shape and endpoints; reject local-network targets,
  embedded credentials and redirect substitution.
- Push contains outcome wording, the saved session name, a cwd-derived project label, opaque
  event/session/project IDs, current grouping policy and a same-origin navigation target. Session names may appear on the lock screen.
  Exclude message text, error details, terminal output, full filesystem paths and credentials. The
  worker can display it without fetching from the Host. Short-lived worker state retains handled
  outcome identities and the latest result per session/project for 24 hours, separately from shell caches.
  Grouping policy persists independently; visible notification member data lasts with its system slot.
- Clicking focuses an existing window or opens the installed-app scope, authenticates normally and
  selects the target conversation. Preserve the opaque target through pairing or Host downtime;
  a newer click supersedes an older target. A deleted target shows the selection error. Navigation
  never starts or retries agent work.

## Platform contract

| Platform | Intended experience |
| --- | --- |
| Linux Chrome desktop/PWA | Page and background notifications while Chrome's background runtime remains available |
| Supported Android browser/PWA | Worker notifications through Web Push, including background/lock screen |
| iPhone/iPad | HTTPS Home Screen app with explicit permission and background/lock-screen Web Push |

The Host must be running with outbound access to the push service. Push reception needs no public
inbound Host access. Remote enrollment and click-through require a trusted HTTPS origin reachable
by the device. Browser force-stop, OS notification policy and network availability can prevent delivery.

## Checks

Regressions cover outcome classification/identity, installation ownership, live-to-push fallback,
expiry/cancellation, privacy and authenticated navigation. Exercise real normal/error outcomes,
explicit Stop, refresh during work, multiple windows and closed-page click-through. Verify direct
workers and native Pi separately. Platform acceptance verifies real system display in an installed
Linux Chrome app while another application is focused, a background or locked Android device, and
an iOS Home Screen app; current evidence and gaps stay in the stage.

## Sources

Design follows the notification investigation on 2026-10-22; implementation evidence is in
[[follow-notifications-2026-10-22]].

- [MDN: Notification constructor](https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification) — mobile display support.
- [MDN: Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) — subscriptions and worker wakeup.
- [WebKit: Web Push for Home Screen apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) — iOS installation and permission.
- [WebKit: Meet Web Push](https://webkit.org/blog/12945/meet-web-push/) — visible delivery requirement.
- [web.dev: Push FAQ](https://web.dev/articles/push-notifications-faq) — page closure and browser exit.
