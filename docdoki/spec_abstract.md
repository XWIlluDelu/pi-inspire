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
| Tagged | Annotated tag v0.6.0 points to f67d6ee, which passes complete Linux/macOS/Windows CI and three installed-package checks. [[follow-project-quality-2026-10-21]] records verified repairs; [[follow-release-0-6-0-2026-10-21]] records the tag, documentation and eight screenshots. There is no GitHub Release or uploaded release-asset distribution. Production activation is a separate operator action. |
| Implemented | Native image delivery, draft-preserving connected-terminal sends and real dialog cancellation; saved-only JSONL export, loaded-range search/History handoff and mobile inspection Back; explicit per-session terminal handoff and narrow terminal quoting back to the editable draft. See [[pi-integration]], [[composer]], [[session-branches]], [[workbench]] and [[session-continuity]]. |
| Implemented | Store-independent extension dialog content and a complete source-DIY task-board example, keeping behavior and commands in Pi. [[pi-integration]] and [the extension guide](../docs/extensions.md#choose-the-smallest-integration) describe the reusable boundary; no runtime React plugin or scheduler is added. |
| Implemented | Bounded Git source projection keeps edits reachable beyond long unchanged prefixes, with independent syntax context and explicit context limits. [[workspace-layout]] records the contract and real-Git/Host regression. |
| Implemented | Run-scoped reclaimable Pending handoffs with Host-held image transfer that preserves later draft actions, project-bound terminal intent, verified native-connection rebind retirement, run-level cancellation, scope-bound digest confirmation and view-bound Prompt Map navigation. Contracts and regression evidence are in [[composer]], [[terminal]], [[herdr-enhancement]], [[conversation]] and [[session-transport]]. |
| Implemented | Native Herdr continuity and process-bound external-session presence fencing, with independent busy/input activity reporting. [[follow-session-execution-2026-10-19]] records verification and the separate Host/Pi activation boundary. |
| Implemented | Ready-owned development pairing, native terminal clipboard/interrupt modifiers and focus entry/exit through existing controls. [[platform-compatibility#Development launch and terminal input]] records native startup and browser coverage. |
| Implemented | Scoped read-only Git, distinct native/URL file identity, native terminal alternate-character input, current-runtime shell/filesystem support, per-instance lifecycle controls, local peer authentication and one-use launch links. Windows/macOS/Linux evidence and capability limits are in [[platform-compatibility]]. |
| Implemented | Ordinary page restart for launcher-owned Hosts preserves independent terminals on Windows, macOS and Linux. Ownership, cleanup and restart-scope contracts are in [[host-lifecycle]]. |
| Implemented | Native session, input, model/authentication, compaction and branch workflows; MCP file configuration; rich conversation readers; Files/Changes; project terminals; responsive layouts and theme families. See [README](../README.md) for the capability overview. |
| Blocked on Pi | Worker-owned settings-save results, resource omission diagnostics, request-attributed dialog cancellation, complete loaded-extension inventory, generic argument completion and structured current-worker MCP management. [[pi-capability-gaps]] identifies the missing interfaces. |
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
