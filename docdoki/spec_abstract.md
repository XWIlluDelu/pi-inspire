# Design overview

## Documentation roles

- `docdoki/` — Project design and work records: product intent, design decisions, specifications,
  implementation progress, and verification evidence.
- `docs/` — Usage and adaptation guides: installation, operation, maintenance, Pi extension
  adaptation, and interface customization.

Link related topics across the two libraries rather than duplicating detailed content.

## Architecture

Inspire is Pi's graphical interface, aiming for broad native-feature coverage and extension support.
Pi and user configuration own tools, prompts, extensions, and the canonical session files. The
authenticated local Host adapts RPC and owns privileged operations; browsers render replaceable
projections and recover from Host state after reconnect.

The default backend launches Pi directly. Optional Herdr enhancement supplies a real pane environment
through the same RPC and GUI, preserving ordinary send, stop, restart, and terminal behavior.
[[northstar]] defines the product boundary and quality requirements.

## Design map

| Area               | Contract                                                          | Implemented surface                                                                                                                     |
| ------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Workbench          | [[workbench]], [[workspace-layout]]                               | Curated session/project navigation, central conversation, contextual Files/Changes/Terminal.                                            |
| Settings           | [[interface-preferences]], [[model-settings]], [[mcp]]            | Interface/runtime preferences; model defaults/common scope, configuration/login, native Router selection and extension-model discovery. |
| Visual system      | [[visual-language]], [[design-system]]                            | Light/dark Amber and Jade, IBM Plex Sans SC for reading/UI, Flux Mono SC for code.                                                      |
| Conversation       | [[conversation]], [[activity-presentation]]                       | Typed text/activity flow, adjustable detail, compaction checkpoints, and reply errors.                                                  |
| Rich content       | [[rich-rendering]], [[tool-presentations]]                        | Shared streaming Markdown/math rendering and typed native/custom tool cards.                                                            |
| Sessions           | [[session-continuity]], [[session-persistence]]                   | Native Pi records, concurrent background workers, complete paged History, and verified persistence.                                     |
| Session operations | [[session-transport]], [[session-branches]], [[session-deletion]] | Addressed reconnect, inspect-before-continue History, optional branch summaries, independent Fork/Clone, and desktop Trash.             |
| Input              | [[composer]]                                                      | Text, references, images/files, Steer/Queue, pending-input recovery, complete copying, and independent draft handoff.                   |
| Pi integration     | [[pi-integration]]                                                | Installed Pi configuration, adapted native commands, extension dialogs/status/text widgets.                                             |
| Host               | [[host-lifecycle]]                                                | Pairing, installation, user environment, diagnostics, build publication, and explicit restart.                                          |
| Herdr              | [[herdr-enhancement]]                                             | Default-off Linux worker placement, scoped cleanup, recovery, and Runtime-derived status.                                               |
| Project terminal   | [[terminal]]                                                      | Independent PTY daemon, ordered tabs, explicit input owner, touch keys, and native text selection/copy.                                 |
| Files and Changes  | [[resource-preview]]                                              | Filesystem browsing/search, session-authorized previews, document-relative resources, and Git diffs.                                    |
| Connections        | [[connection-modules]]                                            | Optional ingress to the same paired Host, including the separate terminal data plane.                                                   |

## Current state and open work

Conversation, session, file and terminal workflows are implemented on Linux, macOS and Windows.
Herdr and managed reverse SSH require Linux. [User guides](../README.md#pi-commands-and-customization)
cover usage and adaptation; [[dependency-boundaries]] records the external-Pi boundary.

The Pi 1.0 review added Pending text/image recovery, durable uploads, prompt history/tab-local drafts,
native shell input, independent command preparation/export, model configuration/login, full-content
session search, inspect-first History, Fork/Clone and cooperative compaction cancellation. Shared
Settings controls, title-owned actions, topbar status and visible Pending keep those workflows compact.
Completed task records are archived; [[pi-capability-gaps]] owns the remaining
native-capability backlog:

- **Settings/resources:** native save-error feedback, loading/trust-omission diagnostics, complete loaded
  extensions, usage reading and further graphical setting coverage remain open.
- **Extensions:** richer reusable UI, draft access, argument completion and extension-owned dialog
  dismissal remain open. Dedicated panels require extension source changes. Codemode and nested-call
  presentation is implemented.
  Complete MCP Settings management is deferred because Pi 1.0 lacks a public current-worker management
  interface; Inspire does not modify Pi to fill that gap.
- **Commands/History:** `/import`, `/share`, `/bug` and `/trust` remain guidance-only. Labels, secondary
  filters, fuller tree keyboard navigation and copy-selected-entry remain gaps; palette preparation,
  browsing and submission refinements are undecided proposals.

Immediate retirement of compact-success receipts remains undecided. [[native-command-compatibility]]
provides the feedback inventory; [[file-browsing]] tracks the separately deferred Files design.

## Implementation evidence

- **Runtime and delivery:** [[state-ownership]], [[platform-compatibility]], and
  [[native-command-compatibility]] explain observation, retirement, restart admission, and command
  dispatch. [[state-ownership]] cover persistence
  and asynchronous selection ownership; [[state-ownership]] explains catalog/default previews
  and save-time invalidation.
- **Terminal:** [[workbench-implementation]] covers the compact controls, touch input, text
  selection, clipboard ownership, and browser checks.
- **Files and documents:** [[workbench-implementation]] explain
  independent discovery/authorization, inline local images, and document navigation.
- **Installation:** [[dependency-boundaries]] and [[platform-compatibility]] record the installed-Pi
  boundary and shell-environment behavior. Per-surface specs link their remaining evidence.
