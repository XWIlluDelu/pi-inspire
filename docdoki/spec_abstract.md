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

## Current work

Frontend improvement continues in small batches for review of each concrete net change.
[[follow-frontend-refinement-2026-10-07]] records the current baseline, retained fixes and next candidates.
Feedback on a particular visual change does not cancel independent work or restrict the project to
bug fixes. Clear functional defects can be repaired and retained, but do not replace frontend
improvement. Floating reading controls and the activity rails remain; the Files layout experiment
was withdrawn, while its two independent preview-control/label cleanups are retained. The latest
Changes batch adds source syntax highlighting and filename-appropriate icons without changing its
layout, navigation or addition/deletion backgrounds; it is ready for user review.

[[follow-pi-native-capability-review-2026-10-02]] owns the remaining native-capability backlog.
The separate presentation questions are compact-success receipts in
[[follow-native-command-surface-2026-09-04]] and Files layout in
[[follow-file-browsing-experience-2026-08-24]]. Per-surface specifications link implementation and review
evidence; completed task records remain in the archive.

Completed maintainability review and native CI repairs: [[maintainability-review]].
