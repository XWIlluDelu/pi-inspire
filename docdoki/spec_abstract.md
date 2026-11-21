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
| Workbench & Layout | [workbench](specs/workbench.md), [workspace-layout](specs/workspace-layout.md) |
| Visual & Preferences | [visual-language](specs/visual-language.md), [design-system](specs/design-system.md), [interface-preferences](specs/interface-preferences.md) |
| Conversation & Content | [conversation](specs/conversation.md), [activity-presentation](specs/activity-presentation.md), [rich-rendering](specs/rich-rendering.md), [tool-presentations](specs/tool-presentations.md), [notifications](specs/notifications.md) |
| Input & Models | [composer](specs/composer.md), [model-settings](specs/model-settings.md), [mcp](specs/mcp.md) |
| Sessions | [session-continuity](specs/session-continuity.md), [session-persistence](specs/session-persistence.md), [session-transport](specs/session-transport.md), [session-branches](specs/session-branches.md), [session-deletion](specs/session-deletion.md) |
| Pi & Hosting | [pi-integration](specs/pi-integration.md), [host-lifecycle](specs/host-lifecycle.md), [herdr-enhancement](specs/herdr-enhancement.md) |
| Tools & Remote | [terminal](specs/terminal.md), [resource-preview](specs/resource-preview.md), [connection-modules](specs/connection-modules.md) |

## Work state

| State | Work |
| --- | --- |
| Device acceptance open | [Task-alert device acceptance](stages/follow-notifications-2026-10-22.md) tracks Android background delivery and iOS Home Screen notifications. |
| Deferred layout | [File browsing](stages/file-browsing.md) tracks deferred responsive Files search placement. |
| Release history | [Changelog](../CHANGELOG.md) and [verified platform baseline](notes/platform-compatibility.md#verified-native-baseline). |
| Blocked on Pi | [Pi capability gaps](stages/pi-capability-gaps.md) lists GUI requirements blocked on owning-worker Pi interfaces. |

## Open decisions

- The [wide-pane Files search placement](stages/file-browsing.md#deferred-design-questions) is deferred until the responsive Files layout is reviewed as a whole.
- [Pi-related proposals](stages/pi-capability-gaps.md#open-proposals) await a scope decision.

## Engineering notes

- [dependency-boundaries](notes/dependency-boundaries.md) — installed Pi, development pins and licensing.
- [state-ownership](notes/state-ownership.md) — generations, observations, receipts and reconciliation.
- [platform-compatibility](notes/platform-compatibility.md) — shell capture, process identity and terminal backends.
- [workbench-implementation](notes/workbench-implementation.md) — references, streaming projections and browser-owned chrome.
- [performance](notes/performance.md) — reproducible workloads and measurement.
- [native-command-compatibility](notes/native-command-compatibility.md) — native test setup and evidence about automatic terminal Pi handoff.
- [remote-relay-options](notes/remote-relay-options.md) — alternatives to reverse SSH.
