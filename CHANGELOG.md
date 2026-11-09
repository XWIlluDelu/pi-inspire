# Changelog

## 0.7.0 — 2026-11-09

Changes since [v0.6.5](https://github.com/XWIlluDelu/pi-inspire/tree/v0.6.5).

### Sessions shared with terminal Pi

- Terminal Pi and Inspire can open the same session. **Copy resume command** copies the
  `pi --session …` command without handing off the session.
- The [attach-control](extensions/attach-control.ts) extension replaces the session bridge while
  keeping existing install paths working. It reports live Pi sessions, branches and activity and
  supports browser control in ordinary terminals and Herdr.
- A branch that a live terminal Pi is running opens read-only with live progress. **Take over**
  connects to that Pi while the terminal keeps working. If it exits or switches sessions,
  Inspire continues the view with its own Pi.
- Inspire accepts appends from other Pi processes and keeps each view on its branch. Use
  **Switch branch…** in the title menu or select a branch in History for read-only sessions.

### Workbench

- Conversation search stays in the desktop reading rail and shares a tool row with Prompt Map
  on narrow layouts. The All, User and Model scopes fit when the side panes narrow the reader.
- The navigation toggle surfaces unread outcomes from other sessions in collapsed and narrow
  layouts. Folder rows use consistent spacing, session ages follow runtime colours, and Settings
  moves into the narrow navigation drawer.
- Files, Git changes and project terminals share one tab strip. Conversation links reuse an
  existing file tab and open the requested line. Refresh preserves the reading position and
  keeps confirmed previews available. The Changes count sits beside its icon.
- PDF previews scroll continuously through pages. Narrow readers give opening Markdown text room
  to clear the reading controls, and the composer offers **Expand** when the editor can grow.
- Activity headers use the mono face. Expanded groups summarize their steps, tools and failed
  calls in one line.
- The Carbon & Silicon palette adds a monochrome option in light and dark. Structural labels use
  IBM Plex Sans SC in sentence case.

### Host and native Pi

- Host settings offer **Restart Host**, which reloads taken-over Pi and keeps project terminals
  open, and **Restart all**, which also restarts the installed Linux terminal service and closes
  its project terminals. The browser tracks a submitted restart across reconnects.
- `inspire restart --host-only` keeps every Pi process and its running work. Inspire rediscovers
  its former workers with **Take over**, including their pending browser questions.
- Inspire finds Pi installed through supported version and package managers and preserves native
  OAuth model defaults and MCP project trust. The provider chooser keeps its initial focus and
  position in the settings panel.
- The native Pi compatibility pin moves from 1.3.0 to 1.5.0. The `inspire mock` command and
  `npm run start:mock` are removed. Use `npm run dev` to run a development checkout with native Pi.
- Declared status controls keep their machine-readable state out of the header automatically.
  `INSPIRE_HERDR_ENV_EXCLUDE` can keep selected extension environment prefixes out of the shared
  Herdr server.
- See the [package installation guide](docs/host.md#build-and-install-a-package) and the
  [one-time upgrade steps for a running 0.6.5 Host](docs/host.md#older-hosts-and-restart-preparation).

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
