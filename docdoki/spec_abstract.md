# Design overview

## Architecture and documentation

Inspire is Pi's graphical interface. Pi and user configuration own tools, prompts, extensions and
canonical session files. The authenticated Host adapts public RPC and owns privileged operations;
browsers render recoverable projections of Host state. Direct Pi launch is the default; optional
Herdr enhancement changes worker placement without changing agent ownership.

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
| Rich content and custom presentations | [[rich-rendering]], [[tool-presentations]] |
| Input, models and MCP | [[composer]], [[model-settings]], [[mcp]] |
| Session discovery and persistence | [[session-continuity]], [[session-persistence]] |
| Transport and prompt observations | [[session-transport]] |
| History, Fork/Clone and exports | [[session-branches]] |
| Session deletion | [[session-deletion]] |
| Pi integration and hosting | [[pi-integration]], [[host-lifecycle]], [[herdr-enhancement]] |
| Terminals, Files and Changes | [[terminal]], [[resource-preview]] |
| Remote connections | [[connection-modules]] |

## Work state

| State | Work |
| --- | --- |
| Implemented | Native session, input, model/authentication, compaction and branch workflows; MCP file configuration; rich conversation readers; Files/Changes; project terminals; responsive layouts and theme families. See [README](../README.md) for the capability overview. |
| Blocked on Pi | Worker-owned settings-save results, resource omission diagnostics, request-attributed dialog cancellation, complete loaded-extension inventory, generic argument completion and structured current-worker MCP management. [[pi-capability-gaps]] identifies the missing interfaces. |
| Deferred | Holistic Files layout work in [[file-browsing]]. The current layout remains the implemented contract. |
| Undecided | Additional History, usage, configuration and palette enhancements in [[pi-capability-gaps]]; reusable extension UI beyond current RPC adaptation in [[northstar]]. |

## Engineering notes

- [[dependency-boundaries]] — installed Pi, development pins and licensing.
- [[state-ownership]] — generations, observations, receipts and reconciliation.
- [[platform-compatibility]] — shell capture, process identity and terminal backends.
- [[workbench-implementation]] — references, streaming projections and browser-owned chrome.
- [[performance]] — reproducible workloads and measurement.
- [[native-command-compatibility]] — native dispatch and operation boundaries.
- [[remote-relay-options]] — alternatives to reverse SSH.
