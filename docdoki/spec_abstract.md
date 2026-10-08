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
was withdrawn, while its two independent preview-control/label cleanups are retained. Changes source
highlighting and filename-appropriate icons form the retained baseline. The accepted Models slice
distinguishes Common checkboxes, Default radios and rule-edit actions, and quiets provider headings
without reordering Settings. The accepted main Settings category views preserve drafts and login
state and use one narrow selection underline. The accepted Terminal settings slice follows the same
navigation for Appearance, Interaction and Saved output, retaining browser preferences and ongoing
Host operations.
The attachment/Pending slice is accepted at `e96c3ea`: file chips emphasize names and state, and
Pending retains deliberate idle dimming and interaction emphasis, with one total and non-repeating,
truthful mode labels. Narrow Model/Thinking adjacency is accepted at `acbcf3f`, with long model
labels shrinking to preserve Thinking and the filled red Stop unchanged. Command Palette headings are
accepted at `71769cf`: quiet labels retain their typography, spacing and interactions without shaded
bands or bottom rules. The session-row overflow experiment is withdrawn: frequent Pin/Hide actions
remain directly available on narrow/touch rows. The independent Pending header action order
Copy/Return/Clear is retained at `1013f42`. Quiet secondary buttons are accepted at `a5ad7e7`:
existing History, earlier-branch Clone and Terminal recovery buttons keep readable labels and
interaction feedback without enabled resting fills/borders. History configuration order is accepted
at `d712e24`: same-session summary settings precede Edit / Continue, retaining the fixed action dock
and separate Fork/Clone group. Welcome's directory-first visual experiment is withdrawn; the
original bordered path input below the toolbar and hero spacing are restored. Its independent
Enter repair remains, preserving message autofocus and preventing implicit creation from directory
editing. Content-action presentation is also ready for review:
CodeMode, custom-message and extension-widget Copy join the revealed group; summaries use header-only
activation. Response Copy uses 0.50 desktop idle opacity, while all Pending controls stay visible
and share the panel's existing 0.75-to-1 emphasis. User Copy/Fork, constant copy surfaces and
touch defaults are preserved; [[design-system]] holds the complete assignment table.
The topbar location-glyph experiment is withdrawn; the project name/path retains its plain-text
presentation and original copy feedback. [[workspace-layout]] holds the contract.

[[follow-pi-native-capability-review-2026-10-02]] owns the remaining native-capability backlog.
The separate presentation questions are compact-success receipts in
[[follow-native-command-surface-2026-09-04]] and Files layout in
[[follow-file-browsing-experience-2026-08-24]]. Per-surface specifications link implementation and review
evidence; completed task records remain in the archive.

Completed maintainability review and native CI repairs: [[maintainability-review]].
