# Changelog

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
