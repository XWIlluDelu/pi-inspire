# Design overview

## Architecture and documentation

Inspire is Pi's graphical interface. Pi and user configuration own tools, prompts, extensions and
canonical session files. The authenticated Host adapts public RPC and owns privileged operations;
browsers render recoverable projections of Host state. Direct Pi launch is the default; optional
Herdr enhancement changes worker placement and connects existing Pi terminals without taking ownership of them.

[northstar](northstar.md) defines product intent. `specs/` holds decided behavior, including requirements not
yet implemented; `notes/` explains reusable engineering choices; `stages/` tracks open work.
User and operator guides live in [docs](../docs/host.md). Completed progress archives remain local
and untracked.

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

- **Optional Mono interface:** the existing palette picker adds neutral Light/Dark surfaces
  inspired by VS Code Modern. Existing defaults and saved choices remain intact; syntax
  highlighting is unchanged under [design-system](specs/design-system.md).
- **Native Pi workflow:** conversations, rich input, model/thinking selection, native configuration and
  authentication, compaction, History, Fork/Clone and exports. Saved history remains readable when
  execution is unavailable, including saved-only JSONL export. [pi-integration](specs/pi-integration.md), [model-settings](specs/model-settings.md),
  [mcp](specs/mcp.md) and [session-branches](specs/session-branches.md) define the boundaries.
- **Session continuity:** background work, draft-preserving Pending recovery, independent copies and
  explicit terminal handoff. The optional [Inspire session bridge](../extensions/inspire-session-bridge.ts)
  reports external Pi activity and presence. With Herdr, browser input, images, agent Stop and model/thinking selection
  reuse the existing native Pi process. Reload, Compact and model cycling stay in that terminal.
  [composer](specs/composer.md), [session-continuity](specs/session-continuity.md) and [herdr-enhancement](specs/herdr-enhancement.md) own the contracts;
  [follow-session-execution-2026-10-19](stages/follow-session-execution-2026-10-19.md) records native continuity evidence and the separate Host/Pi
  activation boundary.
- **Unobtrusive feedback and recovery:** routine selection and preparation feedback stays in the
  existing controls instead of adding progress lines. Update checks preserve known notices and copy
  actions; login progress uses one status position. Catalog, snapshot, History and file reads, together
  with update-check requests, recover automatically while retaining confirmed content. Unsent uploads retain their browser-held bytes; recovery never
  replays branch commands or prompts with uncertain acceptance. [workbench](specs/workbench.md), [session-continuity](specs/session-continuity.md),
  [session-transport](specs/session-transport.md), [session-branches](specs/session-branches.md), [composer](specs/composer.md) and [resource-preview](specs/resource-preview.md) define the scope.
- **Reading and workspace tools:** rich conversation/activity readers, source-backed Copy, Files and
  Changes with in-place refresh, previews and persistent project terminals. Responsive inspection
  preserves the reading context and supports terminal quoting back to the draft. Session actions
  and file inspection retain browser-tab-local workbench state across page reloads; Ctrl+click shows
  authorized files and directories in the Host's file manager. Session actions
  include full-ID copy and a compact menu whose drag handles share saved ordering with Behavior
  settings under [interface-preferences](specs/interface-preferences.md).
  See [conversation](specs/conversation.md), [workspace-layout](specs/workspace-layout.md), [resource-preview](specs/resource-preview.md), [terminal](specs/terminal.md) and [workbench](specs/workbench.md).
- **Extension adaptation:** standard RPC dialogs, status and text widgets, composable external GUI
  adapters with Settings enablement, status-bound composer choices and declarative presentations,
  plus a source-DIY task-board example. [pi-integration](specs/pi-integration.md) and
  [the extension guide](../docs/extensions.md#choose-the-smallest-integration) describe reuse while
  Pi retains behavior and commands.
- **Host operation:** authenticated local/remote browser access, per-instance lifecycle controls,
  isolated development pairing and Host-only restart that preserves independent terminals on
  Linux, macOS and Windows. [host-lifecycle](specs/host-lifecycle.md) defines ownership and restart scopes;
  [platform-compatibility](notes/platform-compatibility.md) records platform evidence and limits.

## Work state

| State | Work |
| --- | --- |
| Review fixes validated | [Runtime quality](stages/follow-runtime-quality-2026-10-25.md) covers asynchronous ownership and lifecycle behavior. The CI repair at `c7f74095` was activated as 0.6.5. Six subsequent review fixes and their fixture corrections pass the full seven-job matrix at `auto-dev` revision `2fe2dc73`; `main` and the existing release tag retain their reviewed baseline. |
| Implemented | [Workbench interactions](stages/follow-workbench-interactions-2026-10-24.md) covers persistent desktop search, narrow change inspection, control-local feedback, smaller radii, underlined resource modes and shared error ink. Opened-file tabs and fixed tool icons now share the right pane, with independent file reading positions, retained terminal state and a larger manual right-pane width budget. Composer attachments align with the existing text inset; structural typography stays unchanged. The stage retains undecided interaction proposals. |
| Integrated | Repairable settings, independently readable/copyable history, durable delivered attachments, operation recovery, configurable adapters and responsive workbench improvements are consolidated from `auto-dev`. [follow-project-quality-2026-10-21](stages/follow-project-quality-2026-10-21.md) records the scope and verification. |
| Implemented; device acceptance partial | Host-owned task outcomes, device-local alert settings and Web Push. Linux Chrome delivery, installed-PWA refresh continuity and Android system display of a manual test are verified. [notifications](specs/notifications.md) defines the contract; [follow-notifications-2026-10-22](stages/follow-notifications-2026-10-22.md) records remaining Android background-task/click and iOS acceptance. |
| Tagged | Annotated source tag v0.6.5 includes the [changelog](../CHANGELOG.md), a clear production dependency audit and local Linux installed-package verification recorded in [runtime quality](stages/follow-runtime-quality-2026-10-25.md). Historical v0.6.0 cross-platform evidence remains in [its release record](stages/follow-release-0-6-0-2026-10-21.md). No GitHub Release, uploaded assets or npm publication accompanies this tag. |
| Blocked on Pi | Backward model cycling, effort preservation during live model-only selection, native TUI shell interruption, worker-owned settings-save results, resource omission diagnostics, request-attributed dialog cancellation, complete loaded-extension inventory, generic argument completion and structured current-worker MCP management. [pi-capability-gaps](stages/pi-capability-gaps.md) identifies the missing interfaces. |
| Deferred | Automatic native-session takeover: no simple supported path was found; existing native control and post-release recovery remain in place. [Native continuity](stages/follow-session-execution-2026-10-19.md) records the feasibility review. Holistic Files layout work remains in [file-browsing](stages/file-browsing.md); the current layout remains the implemented contract. |
| Undecided | Additional History, usage, configuration and palette enhancements in [pi-capability-gaps](stages/pi-capability-gaps.md). Source-level extension UI reuse follows [northstar](northstar.md); further framework-level expansion has no decided requirement. |

## Engineering notes

- [dependency-boundaries](notes/dependency-boundaries.md) — installed Pi, development pins and licensing.
- [state-ownership](notes/state-ownership.md) — generations, observations, receipts and reconciliation.
- [platform-compatibility](notes/platform-compatibility.md) — shell capture, process identity and terminal backends.
- [workbench-implementation](notes/workbench-implementation.md) — references, streaming projections and browser-owned chrome.
- [performance](notes/performance.md) — reproducible workloads and measurement.
- [native-command-compatibility](notes/native-command-compatibility.md) — native dispatch and operation boundaries.
- [remote-relay-options](notes/remote-relay-options.md) — alternatives to reverse SSH.
