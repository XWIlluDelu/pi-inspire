# Design overview

## Architecture and documentation

Inspire is Pi's graphical interface. Pi and the user's configuration own tools, prompts,
extensions and the canonical session files. The authenticated Host adapts Pi's public RPC, runs
Inspire's own Pi workers and performs privileged operations such as file access, terminals and
deletion; browsers render recoverable projections of Host state. A terminal Pi running the
attach-control extension can share a session with Inspire; neither takes ownership of the other.
Pi workers launch directly by default; the optional Herdr enhancement changes only where
Inspire's own workers run.

[northstar](northstar.md) defines product intent, including browser priorities. `specs/` holds
decided behavior, including requirements not yet implemented; `notes/` explains reusable
engineering choices and evidence; `stages/` tracks open work and known gaps. User and operator
guides live in `docs/`, starting from the [README](../README.md). Completed stages are archived
locally and are not tracked.

## Design map

| Area | Contracts |
| --- | --- |
| Workbench and layout | [workbench](specs/workbench.md), [workspace-layout](specs/workspace-layout.md) |
| Visual system and preferences | [visual-language](specs/visual-language.md), [design-system](specs/design-system.md), [interface-preferences](specs/interface-preferences.md) |
| Conversation and activity | [conversation](specs/conversation.md), [activity-presentation](specs/activity-presentation.md) |
| Task notifications | [notifications](specs/notifications.md) |
| Rich content and custom presentations | [rich-rendering](specs/rich-rendering.md), [tool-presentations](specs/tool-presentations.md) |
| Input, models and MCP | [composer](specs/composer.md), [model-settings](specs/model-settings.md), [mcp](specs/mcp.md) |
| Session discovery and persistence | [session-continuity](specs/session-continuity.md), [session-persistence](specs/session-persistence.md) |
| Transport and prompt observations | [session-transport](specs/session-transport.md) |
| History, Fork/Clone and exports | [session-branches](specs/session-branches.md) |
| Session deletion | [session-deletion](specs/session-deletion.md) |
| Pi integration and hosting | [pi-integration](specs/pi-integration.md), [host-lifecycle](specs/host-lifecycle.md), [herdr-enhancement](specs/herdr-enhancement.md) |
| Terminals, Files and Changes | [terminal](specs/terminal.md), [resource-preview](specs/resource-preview.md) |
| Remote connections | [connection-modules](specs/connection-modules.md) |

## Implemented capabilities

- **Native Pi workflow:** conversations, rich input, model/thinking selection, native
  configuration and authentication, compaction, History, Fork/Clone and exports. Saved history
  stays readable when execution is unavailable, including saved-only JSONL export
  ([pi-integration](specs/pi-integration.md), [model-settings](specs/model-settings.md),
  [mcp](specs/mcp.md), [session-branches](specs/session-branches.md)).
- **Session continuity:** background work, draft-preserving Pending recovery and independent
  copies. With [attach-control](../extensions/attach-control.ts) installed, a session a terminal
  Pi is running opens read-only with its progress; **Take over** continues that Pi from the
  browser while the terminal keeps working, and without a live Pi on the viewed branch Inspire
  continues directly. Deletion closes every discovered instance of the session before Trash
  ([session-persistence](specs/session-persistence.md),
  [session-continuity](specs/session-continuity.md), [composer](specs/composer.md);
  activation: [extension guide](../docs/extensions.md#share-sessions-with-terminal-pi)).
- **Quiet feedback and recovery:** routine feedback stays in the control that caused it. Catalog,
  snapshot, History, file and update reads recover automatically and keep confirmed content;
  unsent uploads keep their bytes, and recovery never replays a prompt or branch command whose
  acceptance is unknown ([workbench](specs/workbench.md),
  [session-transport](specs/session-transport.md), [composer](specs/composer.md)).
- **Reading and workspace tools:** rich conversation and activity readers, source-backed Copy,
  Files and Changes with in-place refresh, previews and persistent project terminals. Inspection
  preserves the reading position, and session and file context survive page reloads
  ([conversation](specs/conversation.md), [workspace-layout](specs/workspace-layout.md),
  [resource-preview](specs/resource-preview.md), [terminal](specs/terminal.md),
  [interface-preferences](specs/interface-preferences.md)).
- **Visual system:** botanical, classic and Carbon & Silicon palettes, each in light and dark, on
  one component architecture ([visual-language](specs/visual-language.md),
  [design-system](specs/design-system.md)).
- **Extension adaptation:** standard RPC dialogs, status and text widgets, composable external GUI
  adapters, status-bound Composer choices and declarative presentations, plus a source-level
  task-board example. Pi keeps extension behavior and commands
  ([pi-integration](specs/pi-integration.md),
  [extension guide](../docs/extensions.md#choose-the-smallest-integration)).
- **Host operation:** authenticated local and remote browser access, per-instance lifecycle
  controls, isolated development pairing, and Host-only restarts that keep every Pi running and
  recover its dialogs on attachment ([host-lifecycle](specs/host-lifecycle.md); platform
  evidence and limits: [platform-compatibility](notes/platform-compatibility.md)).

## Work state

| State | Work |
| --- | --- |
| Runtime checks passing; device acceptance open | [Runtime quality](stages/follow-runtime-quality-2026-10-25.md): native ownership, managed Pi discovery and the shared production/test runtime. The seven-job matrix at `2fe2dc73` is the cross-platform baseline; newer Linux unit/integration and static checks pass locally. Android/iOS acceptance and activation are separate. |
| Implemented | [Workbench interactions](stages/follow-workbench-interactions-2026-10-24.md): responsive reading, shared file/terminal tabs, net Git inspection, reload continuity, continuous PDF pages and control-local feedback. The stage holds current evidence and undecided interaction proposals; detailed geometry lives in the linked contracts. |
| Implemented; device acceptance partial | Host-owned task outcomes, device-local alert settings and Web Push ([notifications](specs/notifications.md)). Verified: Linux Chrome delivery, installed-PWA refresh continuity, Android system display of a manual test. Open: Android background-task/click and iOS acceptance ([follow-notifications-2026-10-22](stages/follow-notifications-2026-10-22.md)). |
| Tagged | Annotated source tag v0.6.5: [changelog](../CHANGELOG.md), a clear production dependency audit and local Linux installed-package verification ([runtime quality](stages/follow-runtime-quality-2026-10-25.md)). No GitHub Release, uploaded assets or npm publication. Historical v0.6.0 release evidence: [native baseline](notes/platform-compatibility.md#verified-native-baseline). |
| Blocked on Pi | Backward model cycling, effort preservation during live model-only selection, native TUI shell interruption, worker-owned settings-save results, resource omission diagnostics, request-attributed dialog cancellation, complete loaded-extension inventory, generic argument completion and structured current-worker MCP management. Missing interfaces: [pi-capability-gaps](stages/pi-capability-gaps.md). |
| Deferred | Holistic Files layout work: [file-browsing](stages/file-browsing.md); the current layout remains the implemented contract. |
| Undecided | Additional History, usage, configuration and palette enhancements in [pi-capability-gaps](stages/pi-capability-gaps.md). Source-level extension UI reuse follows [northstar](northstar.md); further framework-level expansion has no decided requirement. |

## Engineering notes

- [dependency-boundaries](notes/dependency-boundaries.md) — installed Pi, development pins and licensing.
- [state-ownership](notes/state-ownership.md) — generations, observations, receipts and reconciliation.
- [platform-compatibility](notes/platform-compatibility.md) — shell capture, process identity and terminal backends.
- [workbench-implementation](notes/workbench-implementation.md) — references, streaming projections and browser-owned chrome.
- [performance](notes/performance.md) — reproducible workloads and measurement.
- [native-command-compatibility](notes/native-command-compatibility.md) — native dispatch and operation boundaries.
- [remote-relay-options](notes/remote-relay-options.md) — alternatives to reverse SSH.
