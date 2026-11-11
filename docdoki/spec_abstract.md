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

## Work state

| State | Work |
| --- | --- |
| Device acceptance open | [Runtime quality](stages/follow-runtime-quality-2026-10-25.md) records native lifecycle evidence, the cross-platform baseline and remaining physical-device checks. |
| Implemented | [Workbench interactions](stages/follow-workbench-interactions-2026-10-24.md) links the reading, input and inspection contracts and records pending platform checks and interaction proposals. |
| Implemented; device acceptance partial | Host-owned task outcomes, device-local alert settings and Web Push ([notifications](specs/notifications.md)). Verified: Linux Chrome delivery, installed-PWA refresh continuity, Android system display of a manual test. Open: Android background-task/click and iOS acceptance ([follow-notifications-2026-10-22](stages/follow-notifications-2026-10-22.md)). |
| Release history | [Changelog](../CHANGELOG.md) and [verified platform baseline](notes/platform-compatibility.md#verified-native-baseline). |
| Blocked on Pi | [Pi capability gaps](stages/pi-capability-gaps.md) lists the GUI requirements and the public interfaces each needs. |
| Deferred | Holistic Files layout work: [file-browsing](stages/file-browsing.md); the current layout remains the implemented contract. |
| Undecided | Additional History, usage, configuration and palette enhancements in [pi-capability-gaps](stages/pi-capability-gaps.md). Source-level extension UI reuse follows [northstar](northstar.md); further framework-level expansion has no decided requirement. |

## Engineering notes

- [dependency-boundaries](notes/dependency-boundaries.md) — installed Pi, development pins and licensing.
- [state-ownership](notes/state-ownership.md) — generations, observations, receipts and reconciliation.
- [platform-compatibility](notes/platform-compatibility.md) — shell capture, process identity and terminal backends.
- [workbench-implementation](notes/workbench-implementation.md) — references, streaming projections and browser-owned chrome.
- [performance](notes/performance.md) — reproducible workloads and measurement.
- [native-command-compatibility](notes/native-command-compatibility.md) — native test setup and evidence about automatic terminal Pi handoff.
- [remote-relay-options](notes/remote-relay-options.md) — alternatives to reverse SSH.
