# Spec abstract

## Architecture

Inspire is the graphical home for Pi. Pi and user configuration own tools, prompts, extensions,
and the canonical session files. The authenticated local Host adapts RPC and owns privileged
operations; browsers render replaceable projections and recover from Host state after reconnect.

The default backend launches Pi directly. Optional Herdr enhancement supplies a real pane environment
through the same RPC and GUI, preserving ordinary send, stop, restart, and terminal behavior.
[[northstar]] defines the product boundary and quality requirements.

## Design map

| Area | Contract | Implemented surface |
| --- | --- | --- |
| Workbench | [[workbench]], [[workspace-layout]] | Curated session/project navigation, central conversation, contextual Files/Changes/Terminal. |
| Settings | [[interface-preferences]] | Display, Conversation, Behavior, and Updates; field-owned persistence and completion attention. |
| Visual system | [[visual-language]], [[design-system]] | Light/dark Amber and Jade, IBM Plex Sans SC for reading/UI, Flux Mono SC for code. |
| Conversation | [[conversation]], [[activity-presentation]] | Typed text/activity flow, adjustable detail, compaction checkpoints, and reply errors. |
| Rich content | [[rich-rendering]], [[tool-presentations]] | Shared streaming Markdown/math rendering and typed native/custom tool cards. |
| Sessions | [[session-continuity]], [[session-persistence]] | Native Pi records, concurrent background workers, bounded history, and verified persistence. |
| Session operations | [[session-transport]], [[session-branches]], [[session-deletion]] | Addressed reconnect, same-file branch navigation, independent fork, and desktop Trash. |
| Input | [[composer]] | Text, references, images/files, Steer/Queue, independent draft handoff, and recoverable delivery. |
| Pi integration | [[pi-integration]] | Installed Pi configuration, adapted native commands, extension dialogs/status/text widgets. |
| Host | [[host-lifecycle]] | Pairing, installation, user environment, diagnostics, build publication, and explicit restart. |
| Herdr | [[herdr-enhancement]] | Default-off Linux worker placement, scoped cleanup, recovery, and Runtime-derived status. |
| Project terminal | [[terminal]] | Independent PTY daemon, ordered project tabs, detachable browsers, and one explicit input owner. |
| Files and Changes | [[resource-preview]] | Filesystem browsing/search, session-authorized previews, document-relative resources, and Git diffs. |
| Connections | [[connection-modules]] | Optional ingress to the same paired Host, including the separate terminal data plane. |

## Current state and follow-ups

The local conversation workflow, Settings upgrade, and Runtime/Herdr repairs are implemented.
Development checks pin Pi 0.87.0; running installations use their separately installed Pi.
Direct Host operation supports Linux, macOS, and Windows; the Herdr module requires Linux systemd
user scopes. `README.md` describes installation and operating requirements.

Two design follow-ups remain:

- **Native command presentation:** commands and delivery are complete. The compact-success receipt
  proposal awaits the requested transcript inventory and a presentation decision.
  [[follow-native-command-surface-2026-09-04]] records the current lifecycle and next actions.
- **Files visual design:** functional browsing and document previews are complete. A holistic visual
  review is deferred; the current layout remains in force.
  [[follow-file-browsing-experience-2026-08-24]] records the questions to revisit.

## Implementation evidence

- **Runtime and delivery:** [[operation-lifecycle-ownership]], [[explicit-restart-controls]], and
  [[native-command-compatibility]] explain observation, retirement, restart admission, and command
  dispatch. [[projection-reconciliation-ownership]] and [[async-ownership-review]] cover persistence
  and asynchronous selection ownership.
- **Herdr:** [[follow-herdr-enhancement-2026-09-25]] records initial transport/environment checks;
  [[follow-deep-review-repairs-2026-09-26]] records the later systemd-scope and real Pi/Bash crash checks.
- **Files and documents:** [[filesystem-git-separation]] and [[document-relative-previews]] explain
  independent discovery/authorization, inline local images, and document navigation.
- **Installation:** [[dependency-boundaries]] and [[user-execution-environment]] record the installed-Pi
  boundary and shell-environment behavior. Per-surface specs link their remaining evidence.
