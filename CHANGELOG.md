# Changelog

## Unreleased

### Sessions shared with terminal Pi

- Terminal Pi and Inspire can use the same session at the same time. The single-writer fence,
  **Use in terminal…** and **Continue in Inspire** are gone; **Copy resume command** copies
  `pi --session …` without changing anything.
- The new generic [attach-control](extensions/attach-control.ts) extension replaces the session
  bridge (old install paths keep loading it). It reports each live Pi's session, branch and
  activity, and accepts control over a private local socket in any terminal, Herdr or not.
- A session a live Pi is running on the viewed branch opens read-only with its progress and
  **Take over**, which attaches to that same Pi; the terminal keeps working. Otherwise Inspire
  continues directly. If the attached Pi exits or moves elsewhere, Inspire continues the view with
  its own Pi.
- Appends from other Pi processes are accepted; a session you work on in Inspire keeps its branch,
  and a read-only view follows the branch it opened on. **Switch branch…** in the title menu, and
  History for read-only sessions, switch branches by the same rule.
- **Restart Host** and `inspire restart` now also reload taken-over Pi so they apply current
  settings. Use `inspire restart --host-only` to keep every Pi process and its running work,
  including Inspire's own workers, which afterwards appear as live Pi with **Take over**.

### Workbench

- Conversation search stays in the desktop reading rail and shares a tool row with Prompt Map
  on narrow layouts. The All, User and Model scopes fit when the side panes narrow the reader.
- On narrow layouts the navigation toggle shows how many other sessions finished, failed or
  need attention, and Settings moves into the navigation drawer.
- A navigation row's age takes its session's runtime state colour, and the working mark is yellow.
- Activity headers use the mono face; expanded groups summarize their steps, tools and failed
  calls in one line.
- Structural labels use IBM Plex Sans SC in sentence case; the Rajdhani face is removed.

### Extensions

- A declared status control's machine-readable state no longer needs a `hiddenStatuses` entry
  to stay out of the header.
- `INSPIRE_HERDR_ENV_EXCLUDE` lists extension environment prefixes kept out of the shared Herdr
  server; no extension prefix is excluded by default.

## 0.6.5 — 2026-10-26

Changes since [v0.6.0](https://github.com/XWIlluDelu/pi-inspire/tree/v0.6.0).

### Notifications

- Device-local tab attention and system notifications, with explicit background Web Push
  enrollment and automatic recovery of interrupted registration.
- Group task notifications by session or project. Titles use current saved session names;
  project groups preserve unread peers while duplicate or delayed delivery cannot re-alert.
- Alert intent, enrollment and grouping remain independent. Core navigation starts without
  waiting for notification registration.

### Sessions and native Pi

- The Inspire session bridge connects existing native Pi terminals without replacing their
  process. With Herdr, supported prompt/image input, Stop and model/thinking controls use that
  same Pi, with stale replies fenced to their original receiver.
- New-session model and effort choices survive directory changes and refreshes. Saved-only
  sessions retain readable model/effort details, history and JSONL export.
- Full-message Copy, history search, previews and forks preserve canonical source content
  instead of relying on shortened browser previews.
- Pending operations recover their original completion across disconnects. Read failures and
  unsent upload preparation recover while retaining confirmed content and browser-held input;
  uncertain writes are not automatically replayed.
- Native observer reclamation, late startup completion and shutdown respect process ownership
  and retire only the appropriate connection or worker.

### Workbench, settings and extensions

- Compact activity mounts only the selected reading window. Folding releases child DOM while
  preserving deliberate disclosure, nested-call, script and output-reading choices.
- Persistent desktop conversation search, composition-aware shortcuts and semantic scroll
  anchors preserve reading context. Narrow Changes inspection restores list position and focus.
- Shared resource search clearing, retained content during refresh, control-local feedback,
  tighter radii, underlined resource modes and improved error text contrast.
- Installed-window titlebars follow modal backdrop depth and palette colors.
- Repairable native configuration, scoped MCP policies and BOM-compatible configuration reads;
  session action visibility and ordering are configurable.
- Reusable extension dialogs and configurable GUI adapters support native extension lifecycles
  and status-bound composer controls without moving agent behavior into Inspire.
- Update checks retain known results through transient failures and distinguish the installed
  Pi version from the version loaded by the running Host.

### Host, terminals and attachments

- Updated request-body parsing, multipart uploads and schema validation dependencies to address
  upstream denial-of-service advisories.
- Session handoff to Pi and terminal quoting back to the composer preserve their native context.
  Observer disconnects, refreshes and failed attaches retain the active terminal control lease.
- Optional terminal notifications cannot interrupt terminal work. Host and terminal maintenance
  preserve their separate ownership and restart scopes.
- Delivered ordinary attachments remain durable across forks, deletion, backups and recovery.
  Automatic cleanup is limited to staging; image copies can be released after persistence in Pi
  history. The Host guide explains deliberate cleanup of delivered files.
- Browser publication retains the outgoing asset generation. Source-build freshness records
  inputs before compilation, so a save during compilation triggers a subsequent rebuild.

### Upgrade notes

- Node.js **22.19 or newer** and an external Pi installation remain required. The development
  compatibility baseline remains Pi **1.3.0**.
- Restart the Host to load updated server code. A Host-only restart preserves terminals and
  does not upgrade their daemon; apply terminal-service changes separately after its work ends.
- Install the updated [Inspire session bridge](docs/extensions.md#share-sessions-with-terminal-pi)
  and reload it in each original idle Pi terminal. Host restart does not reload external Pi.
- Enable background notifications separately on each browser or installed app. Android
  background-task/click and iOS/iPadOS delivery still have outstanding physical-device acceptance.
- This version is distributed as a source tag. The [local tarball workflow](docs/host.md#build-and-install-a-package)
  remains available; no npm publication or downloadable release assets are introduced.

## 0.6.0 — 2026-10-21

Changes since [v0.5.5](https://github.com/XWIlluDelu/pi-inspire/tree/v0.5.5).

### Workbench

- Responsive conversation, History, Files and Settings layouts, with clearer reading feedback,
  consistent text baselines, contained long content and keyboard/touch navigation.
- Updated six-color PWA icons. Stateful actions keep their own labels steady without making
  unrelated buttons equally wide; configuration and command labels are shorter.
- Clearer **Stopped** versus **Pi error** results. Terminal errors use the shared error card
  with Copy and a separate Dismiss action.
- Pending-input recovery preserves images and newer draft edits. Clipboard handling retains
  browser activation and supports recovery after interrupted copies.

### Sessions and native Pi

- Stronger external-writer fencing and verified connection retirement preserve native Pi
  continuity without starting a second writer. With optional Herdr enhancement, supported
  actions run in the connected native Pi instead of a replacement process.
- Model cycling delegates to the native worker. Registered command invocation names and
  native branch-navigation callbacks retain their original meaning.
- Snapshot refreshes coalesce redundant work and confirm the active session's detail before
  reusing it. Prompt Map scope survives outline recovery.

### Host, terminals and files

- Authenticated development startup and portable Host lifecycle controls verify the intended
  instance. Packaged CLI and terminal workflows are validated on Linux, macOS and Windows.
- Terminal IPC uses authenticated TLS and scoped maintenance controls. Shell startup,
  alternate-character input and selection/clipboard behavior retain native keyboard semantics;
  macOS **Option as Meta** remains opt-in.
- A failed startup connection can recover on a later terminal request without restarting the
  Host. Recovery neither replaces a daemon nor replays input or dispatched mutations. Compatible
  data remains available when optional maintenance controls are absent.
- Linux service start/enable leaves an existing transient daemon and its work alone. A confirmed
  duplicate listener stops the new unit's crash loop instead of repeatedly attempting takeover.
- Native Trash recovery and attachment-directory/volume checks preserve recovery ownership.
  Attachments retain their file context across recalled input and user turns.
- Scoped file and Git inspection keeps late edits visible beyond bounded source context.
  Preview-transfer observations remain bounded. Reverse-SSH lifecycle changes are serialized,
  and CLI startup recognizes Windows directory aliases.

### Upgrade notes

- Node.js **22.19 or newer** is required. Pi remains an external installation; this release is
  validated against Pi **1.3.0**, not a bundled agent runtime.
- Compatible terminal daemons survive a Host-only restart. An older daemon that cannot provide
  the authenticated channel needs a one-time terminal-service upgrade after its work is saved
  or completed. Replacing it ends its live PTYs; inspect the exact owner first. **Restart all**
  is not a migration shortcut for an independent transient service.
- Browser terminal appearance/interaction preferences are local to that browser and origin.
  Saved-output retention belongs to the connected terminal service.
- Distribution continues through the verified tarball workflow in
  [Host operations](docs/host.md#build-and-install-a-package). No new npm publication channel
  is introduced.
