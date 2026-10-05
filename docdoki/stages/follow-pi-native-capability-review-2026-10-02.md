---
scope:
  - docdoki/specs/*.md
  - docs/*.md
  - src/**
  - server/**
  - shared/**
  - tests/**
---

# Pi 1.0 capability coverage and remaining gaps

## Objective and current state

Review Inspire against Pi 1.0 while preserving its role as Pi's graphical interface under
[[northstar]]. The native and supporting workflows below have been reviewed. Review coverage is
not full feature coverage: the remaining defects, interface gaps and deferred adaptations are
listed separately.

Native checks used installed Pi 1.0 with isolated settings, credentials and local deterministic
providers. Browser fixtures establish interaction behavior; native checks establish Pi semantics.
Authentication checks did not use real accounts. Most new checks ran on Linux/direct RPC; individual
evidence records retain their platform limits. [[dependency-boundaries]] records the external-Pi
and development-test boundary. [[follow-native-workflow-quality-2026-10-03]] records targeted quality
repairs and integration evidence.

## Implemented surfaces and evidence

| Area                  | Current surface                                                                                                                                                                                                      | Evidence                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Input and Pending     | Send/Steer/Queue; complete text copying; Return/Stop recovery of original submitted images and text.                                                                                                                 | [[follow-pending-input-recovery-2026-10-02]]                                     |
| Files and images      | Inline references preserve sentence position; ordinary uploaded copies have durable reference-based retention.                                                                                                       | [[follow-file-input-lifecycle-2026-10-02]]                                       |
| Editing               | Retained branch prompt history, tab-local text drafts and same-textarea overflow expansion.                                                                                                                          | [[follow-composer-editing-2026-10-02]]                                           |
| Commands              | Ranked palette, draft-independent preparation, native argument assistance, export/download and help. The palette opens from the topbar or Ctrl/Command+K at every width.                                             | [[follow-command-ux-2026-10-02]]                                                 |
| Native shell          | `!`/`!!` through Pi, independent shell activity, cancellation, retained output and full-log access.                                                                                                                  | [[follow-shell-input-2026-10-02]]                                                |
| Models and thinking   | Native thinking transitions, non-interrupting catalog refresh, defaults/common scope, graphical declarations and provider credentials. Models, Login & API keys and Custom providers are separate Settings sections. | [[follow-model-selection-2026-10-02]], [[follow-model-settings-auth-2026-10-02]] |
| Session discovery     | Full retained user/assistant-text and ID search with Pi matching and keyboard result selection.                                                                                                                      | [[follow-session-search-2026-10-02]]                                             |
| History and copies    | Inspect-first paging/search, explicit same-session continuation, optional native summaries and independent Fork/Clone.                                                                                               | [[follow-history-cloning-2026-10-02]]                                            |
| Compaction            | Cooperative native cancellation, confirmed retirement for unresponsive cancellation, and read-only context detail.                                                                                                   | [[follow-compaction-cancellation-2026-10-02]]                                    |
| Tool results          | Persisted tool images and native full shell-output links use the shared authorized viewers.                                                                                                                          | [[follow-tool-result-resources-2026-10-03]]                                      |
| Extension interaction | Standard dialogs, retained deadlines, topbar status at every width, text widgets, custom-message projections and a runnable native-UI example.                                                                       | [[follow-extension-ui-2026-10-03]], [[follow-intercom-message-card-2026-10-02]]  |
| Supporting tools      | Existing Host/remote, optional Herdr, Files/Changes and project-terminal workflows; stale Git feedback and unavailable-Herdr enablement are corrected.                                                               | [[follow-existing-enhancement-review-2026-10-03]]                                |

Contracts own the detailed behavior. [[follow-frontend-change-review-2026-10-03]] maps the current
interface and browser evidence; the [command guide](../../docs/pi-commands.md) describes usage.

## Settings and resource discovery

### Implemented corrections

- **Effective retry:** the owning worker's public settings determine the displayed value after
  setters and in active snapshots. Trusted overrides, untrusted-project exclusion and native defaults
  replace the former cached submitted intent.
- **Command freshness:** discovery and slash admission/delivery use the owning worker's current
  inventory. Native in-process `ctx.reload()` exposes added/removed commands without replacing the
  worker or settling its model work and Pending.
- **Update scope:** the command guide states that extension-package checks cover global/user packages.
  The Settings result label remains Extensions; trust and update execution are unchanged.

Installed-Pi checks cover trusted/untrusted/absent defaults, independent workers, replacement and
in-process command add/remove/admission. Browser checks cover preference persistence/refusal,
command discovery with retained drafts/attachments, and narrow Settings reading. Sources:
`server/{runtime,runtime-slot,pi-rpc,pi-update-checker}.ts`, the native settings/command integration
tests and `src/components/Settings.tsx`.

### Confirmed gaps

- **Persistence feedback:** native behavior setters acknowledge in-memory changes, not successful
  file persistence. An isolated malformed-settings-file probe returned success without saving or
  warning. A supported native setter/flush result needs to expose the error so the GUI can distinguish
  applied-but-not-saved from failed application.
- **Setting scope:** controls save global defaults and address one live worker; existing workers and
  project overrides may differ. The effect needs clearer user-facing explanation.
- **Usage reading:** context/path fact cells can clip values without keyboard/touch access. Current
  context and cumulative usage are distinct native measures; the totals are not thereby incorrect.
- **Startup diagnostics:** a broken startup extension appears as an unexpected RPC closure while
  its actionable load diagnostic remains Host-only. Expose a bounded explanation or diagnostic entry.
- **Omitted resources:** trust-skipped resources and invalid skills can disappear without an
  explanation. Command inventory lists successes, not all omission diagnostics. Keep trust decisions
  with Pi rather than approving projects to populate commands.

Evidence includes isolated Pi settings/discovery/trust/startup probes and two real Runtime workers,
plus desktop/narrow browser settings, usage and Reload checks. Save-result and loading diagnostics
need further interface investigation.

### Unimplemented coverage

- Read-only reopened sessions have no usage summary until a worker starts. Adding retained statistics
  must preserve read-only opening.
- Basic RPC statistics include message/tool counts and input/output/cache breakdowns omitted by the
  GUI. Pi also has per-model/provider costs and cache-warming/re-billing information outside that RPC
  result. Useful disclosure remains a candidate, not a required dashboard.
- Per-model thinking-default editing is not implemented. Cache warming, transport/proxy/timeouts,
  image resizing/blocking, advanced retry/compaction/thinking budgets, and tool/resource/package,
  shell, telemetry and trust settings remain file/CLI configuration. TUI-only display/input settings
  do not require duplicate browser controls.
- A loaded-resource/provenance/diagnostic view and GUI resource/package configuration are absent.
  Complete current-worker extension names are requested in [[interface-preferences]]; command-free
  extensions are not discoverable through `get_commands`.

GUI Reload deliberately replaces the selected idle worker and can reset extension memory and
active-tool selection. Native in-process reload does not. These are different operations, not a
promise of worker-state preservation across graphical Reload.

## Virtual and extension-registered models

A virtual model is a selected routing entry; Pi chooses a physical model for each request. Selected
thinking can differ from the physical request's level. Virtual catalog cost/capacity does not describe
a completed response's usage or effective context capacity.

### Working native behavior

An isolated Pi 1.0 extension alternated two local models through the actual Host runtime. Selected
virtual identity and branch-local router state survived continuation, cold Host reopen, Fork and Clone.
Fork resumed state before the edited input; Clone carried current-branch state. Context followed the
physical response: 1,010 / 16,000 tokens, then 2,010 / 64,000. Response costs summed to $0.032 rather
than the virtual catalog entry's zero price. Browser `/session` showed $0.043 after the reopened
session's third response.

### GUI adaptation — repaired 2026-10-05

[[follow-native-model-workflow-2026-10-05]] repairs both findings below. Owned-worker selection now
supplies picker/thinking/New; readonly recovery uses native branch semantics and registered virtual
definitions. Startup discovery includes global and already-trusted project registrations through the
released public SDK. Default startup lets Pi resolve its model; explicit/inherited choices remain
explicit. Optional metadata does not block initial transcript/bootstrap delivery.

### Pre-repair findings

- **Selected identity becomes response identity.** After a reply the selector and `/session` identify
  the physical responder although Pi still selects the virtual model. Thinking choices then use the
  physical model's levels: a Low/High virtual model incorrectly offered Off/Minimal/Medium, and
  selecting Off resolved to Low in Pi. New inherits the displayed physical identity, bypassing the
  router on its first request; its session file contained a physical `model_change` and no router
  state. Ordinary continuation, Fork and Clone retained routing.
- **Cold-start discovery omits extension registrations.** Without a session to inherit, the standalone
  catalog/default resolver does not load extension models. An extension-only default produced no
  available choices, “Model resolution failed” and disabled Start in a fresh browser. An existing
  worker exposed the model. This also affects extension-registered physical models.

Repair direction: separate Pi's selected identity from the last physical response in snapshots,
read-only projection and New inheritance. Use selection for picker/thinking and response data for
context/usage. Startup discovery must account for the prospective project's registrations. No routing
editor or second permanent selector is added. This repair is independent of Codemode.

Evidence: installed-Pi deterministic routing, native `get_state`/thinking levels versus Host snapshots,
retained router entries, and Chromium cold-start/reopen/New/usage flows. Before repair,
`session-projection.ts` derived identity from assistant responses and `runtime.ts::snapshotSlot`
preferred that projection.
`model-catalog.ts` owns startup discovery; `Welcome.tsx` and `Composer.tsx` use the resulting identity.
Per-model cost breakdown remains the optional disclosure above, not an incorrect-total finding.

## Extension interfaces and tool adaptation

Shared dialogs, notices, status/text widgets, editor replacement and displayed custom messages work
through RPC. Status remains in the topbar; truncated text opens for full reading. The
[adaptation guide](../../docs/extensions.md) lists supported primitives and alternatives.

Remaining interfaces:

- Pi RPC does not serialize custom TUI components, editors/footer/header renderers, terminal shortcuts
  or autocomplete callbacks. Draft reads return an empty string, and `pasteToEditor` replaces rather
  than inserts. Richer reusable GUI components remain open work; dedicated controls require source
  changes. This is not a decision to define extension policy or a general frontend plugin platform.
- Public `get_commands` omits template argument hints and extension argument-completion callbacks;
  `ExtensionAPI.getCommands()` also omits the callbacks. Generic assistance needs a Pi interface
  addition or explicit adapter, not per-package guessing or private monkey-patching.
- Extension-owned AbortSignal cancellation resolves the dialog in Pi 1.0 without a dismissal event.
  An isolated native probe emitted only the original request and completion status; the Host retained
  the request. Timeout and Host Stop cleanup work. Generic command completion/model idleness cannot
  safely substitute for the missing signal.

Tool adaptation evidence is in [[follow-codemode-mcp-adaptation-2026-10-05]]:

- **Codemode:** native `details.calls` feeds compact live/final child rows, including model identity.
  Available parameters, errors and duration open on demand; script inspection stays secondary to the
  result. Existing text/image/authorized-file readers are reused. No cost UI is added.
- **Nested execution:** general `ctx.executeTool()` live parented events and persisted `nestedCalls`
  feed the shared child-call view. Native fixtures and desktop/mobile Adaptive disclosure checks pass;
  the implementation is merged into mainline.
- **MCP:** configured calls already execute through Pi. Complete graphical configuration/connection
  management is deferred: Pi 1.0.0 does not expose its runtime manager through a public structured
  interface. The user explicitly rejected modifying Pi or requiring a patched runtime to fill this
  gap. [[mcp]] retains the conditional GUI design; [[dependency-boundaries]] records compatibility.

The saved-image/full-log failures are repaired separately. Native offline fixtures reproduced the
pre-repair loss of image coordinates and a 2,500-line Bash log link; current paging/resource/browser
regressions are in [[follow-tool-result-resources-2026-10-03]].

## Remaining commands, History and design questions

- `/import`, `/share`, `/bug` and `/trust` are guidance-only, not permanent exclusions.
- Native History labels, secondary filters, fuller tree keyboard navigation and copy-selected-entry
  remain gaps. Same-session navigation deliberately requires idle work, cleared queues and no pending
  dialog rather than Pi TUI's stop-before-jump flow. Independent publication still requires a healthy,
  materialized current-format source.
- **Palette proposals — undecided:** skip preparation for resource commands needing no arguments and
  for plain Compact; provide a lightweight visible browse route for low-frequency actions (typing `/`
  already reveals the inventory); make the prepared editor's Ctrl/⌘+Enter submission evident and
  consistent with ordinary input where appropriate. Implementation evidence remains in
  [[follow-command-ux-2026-10-02]].
- Immediate retirement of compact-success receipts is undecided pending a transcript inventory in
  [[follow-native-command-surface-2026-09-04]]. Broader Files layout questions remain in
  [[follow-file-browsing-experience-2026-08-24]].
