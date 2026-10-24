# Design overview

## Architecture and documentation

Inspire is Pi's graphical interface. Pi and user configuration own tools, prompts, extensions and
canonical session files. The authenticated Host adapts public RPC and owns privileged operations;
browsers render recoverable projections of Host state. Direct Pi launch is the default; optional
Herdr enhancement changes worker placement and connects existing Pi terminals without taking ownership of them.

[[northstar]] defines product intent. `specs/` holds decided behavior, including requirements not
yet implemented; `notes/` explains reusable engineering choices; `stages/` tracks open work.
User and operator guides live in [docs](../docs/host.md). Completed progress archives remain local
and untracked.

## Design map

| Area | Contracts |
| --- | --- |
| Workbench and layout | [[workbench]], [[workspace-layout]] |
| Visual system and preferences | [[visual-language]], [[design-system]], [[interface-preferences]] |
| Conversation and activity | [[conversation]], [[activity-presentation]] |
| Task notifications | [[notifications]] |
| Rich content and custom presentations | [[rich-rendering]], [[tool-presentations]] |
| Input, models and MCP | [[composer]], [[model-settings]], [[mcp]] |
| Session discovery and persistence | [[session-continuity]], [[session-persistence]] |
| Transport and prompt observations | [[session-transport]] |
| History, Fork/Clone and exports | [[session-branches]] |
| Session deletion | [[session-deletion]] |
| Pi integration and hosting | [[pi-integration]], [[host-lifecycle]], [[herdr-enhancement]] |
| Terminals, Files and Changes | [[terminal]], [[resource-preview]] |
| Remote connections | [[connection-modules]] |

## Implemented capabilities

- **Native Pi workflow:** conversations, rich input, model/thinking selection, native configuration and
  authentication, compaction, History, Fork/Clone and exports. Saved history remains readable when
  execution is unavailable, including saved-only JSONL export. [[pi-integration]], [[model-settings]],
  [[mcp]] and [[session-branches]] define the boundaries.
- **Session continuity:** background work, draft-preserving Pending recovery, independent copies and
  explicit terminal handoff. The optional [Inspire session bridge](../extensions/inspire-session-bridge.ts)
  reports external Pi activity and presence. With Herdr, browser input, images, agent Stop and model/thinking selection
  reuse the existing native Pi process. Reload, Compact and model cycling stay in that terminal.
  [[composer]], [[session-continuity]] and [[herdr-enhancement]] own the contracts;
  [[follow-session-execution-2026-10-19]] records native continuity evidence and the separate Host/Pi
  activation boundary.
- **Unobtrusive feedback and recovery:** routine selection and preparation feedback stays in the
  existing controls instead of adding progress lines. Background catalog, snapshot, History and file
  reads recover automatically while retaining confirmed content. Unsent uploads retain their browser-held bytes; recovery never
  replays branch commands or prompts with uncertain acceptance. [[workbench]], [[session-continuity]],
  [[session-transport]], [[session-branches]], [[composer]] and [[resource-preview]] define the scope.
- **Reading and workspace tools:** rich conversation/activity readers, source-backed Copy, Files and
  Changes with in-place refresh, previews and persistent project terminals. Responsive inspection
  preserves the reading context and supports terminal quoting back to the draft. Session actions
  include full-ID copy and a compact menu whose drag handles share saved ordering with Behavior
  settings under [[interface-preferences]].
  See [[conversation]], [[workspace-layout]], [[resource-preview]], [[terminal]] and [[workbench]].
- **Extension adaptation:** standard RPC dialogs, status and text widgets, composable external GUI
  adapters with Settings enablement, status-bound composer choices and declarative presentations,
  plus a source-DIY task-board example. [[pi-integration]] and
  [the extension guide](../docs/extensions.md#choose-the-smallest-integration) describe reuse while
  Pi retains behavior and commands.
- **Host operation:** authenticated local/remote browser access, per-instance lifecycle controls,
  isolated development pairing and Host-only restart that preserves independent terminals on
  Linux, macOS and Windows. [[host-lifecycle]] defines ownership and restart scopes;
  [[platform-compatibility]] records platform evidence and limits.

## Work state

| State | Work |
| --- | --- |
| Integrated | Repairable settings, independently readable/copyable history, durable delivered attachments, operation recovery, configurable adapters and responsive workbench improvements are consolidated from `auto-dev`. [[follow-project-quality-2026-10-21]] records the scope and verification. |
| Implemented; device acceptance partial | Host-owned task outcomes, device-local alert settings and Web Push. Linux Chrome delivery, installed-PWA refresh continuity and Android system display of a manual test are verified. [[notifications]] defines the contract; [[follow-notifications-2026-10-22]] records remaining Android background-task/click and iOS acceptance. |
| Tagged | Annotated tag v0.6.0 points to f67d6ee, with Linux/macOS/Windows CI and three installed-package checks recorded in [[follow-release-0-6-0-2026-10-21]]. The release uses the source tag without uploaded release assets. |
| Blocked on Pi | Backward model cycling, native TUI shell interruption, worker-owned settings-save results, resource omission diagnostics, request-attributed dialog cancellation, complete loaded-extension inventory, generic argument completion and structured current-worker MCP management. [[pi-capability-gaps]] identifies the missing interfaces. |
| Deferred | Holistic Files layout work in [[file-browsing]]. The current layout remains the implemented contract. |
| Undecided | Additional History, usage, configuration and palette enhancements in [[pi-capability-gaps]]. Source-level extension UI reuse follows [[northstar]]; further framework-level expansion has no decided requirement. |

## Engineering notes

- [[dependency-boundaries]] — installed Pi, development pins and licensing.
- [[state-ownership]] — generations, observations, receipts and reconciliation.
- [[platform-compatibility]] — shell capture, process identity and terminal backends.
- [[workbench-implementation]] — references, streaming projections and browser-owned chrome.
- [[performance]] — reproducible workloads and measurement.
- [[native-command-compatibility]] — native dispatch and operation boundaries.
- [[remote-relay-options]] — alternatives to reverse SSH.
