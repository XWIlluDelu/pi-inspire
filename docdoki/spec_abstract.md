# Design overview

## Documentation roles

- `docdoki/` holds product intent, specifications, implementation progress and review records.
- `docs/` holds installation, operation, extension-adaptation and customization guides.

Link related topics rather than duplicating their content.

## Architecture

Inspire is Pi's graphical interface. Pi and user configuration own tools, prompts, extensions and
canonical session files. The authenticated local Host adapts RPC and owns privileged operations;
browsers render replaceable projections and recover from Host state after reconnect.

The default backend launches Pi directly. Optional Herdr enhancement supplies a real pane environment
through the same RPC and GUI. [[northstar]] defines the product boundary;
[[dependency-boundaries]] describes the installed-Pi integration.

## Design map

| Area | Contract |
| --- | --- |
| Workbench | [[workbench]], [[workspace-layout]] |
| Settings | [[interface-preferences]], [[model-settings]], [[mcp]] |
| Visual system | [[visual-language]], [[design-system]] |
| Conversation | [[conversation]], [[activity-presentation]] |
| Rich content | [[rich-rendering]], [[tool-presentations]] |
| Sessions | [[session-continuity]], [[session-persistence]] |
| Transport and prompt observations | [[session-transport]] |
| History, Fork/Clone and exports | [[session-branches]] |
| Session deletion | [[session-deletion]] |
| Input | [[composer]] |
| Pi integration | [[pi-integration]] |
| Host | [[host-lifecycle]] |
| Herdr | [[herdr-enhancement]] |
| Project terminal | [[terminal]] |
| Files and Changes | [[resource-preview]] |
| Connections | [[connection-modules]] |

Files supports explicitly enabled interactive HTML alongside default static rendering.
The user click authorizes script execution and resource loading; the preview retains opaque-origin
isolation from Inspire. [[resource-preview]] defines the capability and lifecycle boundaries.

## Implemented capabilities

- Native input, Steer/Queue with original-image recovery, shell execution, model/thinking controls,
  provider configuration/login, compaction, History navigation, independent Fork/Clone and exports
  use the installed Pi. [[pi-capability-gaps]] links their delivery evidence.
- Conversations retain floating reading controls, activity rails and independent Thinking/tool
  density. Files/Changes share source-reader styling and file identity without merging filesystem
  and Git authority. [[conversation]], [[activity-presentation]] and [[resource-preview]] own the contracts.
- Settings and Terminal settings use category views. Models uses native Common/Default choices and
  focused provider/model editors, preserving browsing context, drafts and login across category
  changes. [[interface-preferences]], [[model-settings]] and [[terminal]] define the behavior.
- All retained frontend refinement groups, including the final Models editors, are accepted.
  [[design-system]] owns shared search, focus, control and status presentation.

## Current work and gaps

The Pi 1.0 core/native and frontend quality review is complete. It repaired bounded live output,
duplicate Git observations and canonical file selection, reconciled documentation, and consolidated
tests by behavior and history by semantic outcome. 
A subsequent remote-CI cross-check repaired Windows bare-path citations and three test-readiness
problems. Native Windows verification remains open.

[[pi-capability-gaps]] owns remaining capability work. Known gaps include
native setting-persistence feedback and scope disclosure, startup/resource diagnostics, extension
dialog cancellation, complete loaded-extension names, fuller History controls and image copying.
Generic extension argument completion and current-worker MCP management need supported public Pi
interfaces; [[mcp]] retains the decided graphical design and distinguishes available file editing
from blocked runtime controls. These obligations remain open.

[[file-browsing]] retains the unimplemented Notebook kernel-name inference
and separately deferred holistic Files design questions.

Completed maintainability and cross-platform CI evidence is in [[state-ownership]].
Measurements in [[performance]] describe their recorded workloads and environments.
