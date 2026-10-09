---
scope:
  - docdoki/specs/*.md
  - docs/*.md
  - src/**
  - server/**
  - shared/**
  - tests/**
---

# Pi capability coverage and remaining gaps

## Objective

Review Inspire against public Pi capabilities while preserving [[northstar]]: Pi owns the agent;
Inspire adapts it, without a patched runtime. Contracts own decided behavior. This stage owns remaining
native gaps and proposals, not a second feature specification.

## Current state

Pi 1.0 native checks used isolated settings/credentials and deterministic local providers; browser
fixtures establish interactions, not provider semantics. Authentication used no real accounts.
Most native evidence is Linux/direct RPC; individual records retain platform limits.
[[dependency-boundaries]] records compatibility, and [[follow-native-workflow-quality-2026-10-03]]
records targeted repairs.

| Implemented area | Evidence |
| --- | --- |
| Input/Pending text and original-image recovery | [[follow-pending-input-recovery-2026-10-02]] |
| Inline files and durable upload retention | [[follow-file-input-lifecycle-2026-10-02]] |
| Prompt history, tab-local drafts and editor expansion | [[follow-composer-editing-2026-10-02]] |
| Palette, command preparation, argument help and downloads | [[follow-command-ux-2026-10-02]] |
| Native `!`/`!!`, cancellation and retained full output | [[follow-shell-input-2026-10-02]] |
| Models, thinking, declarations and Host credentials | [[follow-model-selection-2026-10-02]], [[follow-model-settings-auth-2026-10-02]] |
| Router identity, trusted extension discovery and New inheritance | [[follow-native-model-workflow-2026-10-05]] |
| Complete retained conversation search | [[follow-session-search-2026-10-02]] |
| History, summaries and independent Fork/Clone | [[follow-history-cloning-2026-10-02]] |
| Cooperative compaction cancellation and context detail | [[follow-compaction-cancellation-2026-10-02]] |
| Saved tool images/full logs | [[follow-tool-result-resources-2026-10-03]] |
| Dialogs, status, text widgets and custom messages | [[follow-extension-ui-2026-10-03]], [[follow-intercom-message-card-2026-10-02]] |
| Codemode and nested tool-call presentation | [[follow-codemode-mcp-adaptation-2026-10-05]] |
| Host/remote, Herdr, Files/Changes and project terminals | [[follow-existing-enhancement-review-2026-10-03]] |

Fork now restores saved user images together with text, including image-only messages and ordered
multiple/duplicate images, as independent staged attachments. Source drafts stay in their own
partition; Clone remains endpoint-inclusive with an empty editor. Runtime tests cover restored
bytes, explicit resend/removal and failed-Fork cleanup; stock-Pi integration covers a first-turn
image Fork. Browser-store tests cover partition switching and stale-response withdrawal; desktop
and narrow Chromium checks exercise saved-image preview, upload/removal and explicit resend.
Evidence: `tests/server/{runtime-branching,attachments,pi-branch-bridge.integration}.test.ts`,
`tests/web/branch-store.test.ts` and `tests/browser/history.spec.ts`.
[[session-branches]] and [[composer]] own the contract.

Effective retry reads use the owning worker's public settings, and command discovery/admission use
its current loaded inventory, including native in-process reload. Graphical Reload intentionally
replaces only the selected idle worker; it does not promise extension-memory/tool-selection
preservation. Extension-package update checks cover global/user packages.

Router selection now remains distinct from physical response identity. The native alternating-model
probe preserved branch-local routing across continuation, cold reopen, Fork and Clone; effective
context changed from 1,010/16,000 to 2,010/64,000 tokens and physical response costs totaled $0.032,
not the virtual catalog's zero. Model discovery completes global/trusted-project registration before
resolving defaults and does not block retained transcript/bootstrap reads. The earlier Router and
cold-start defects are repaired, not current limitations. [[model-settings]] owns the contract.

## Confirmed gaps

- **Native setting persistence feedback:** setters acknowledge applied in-memory values, not a
  successful file save. An isolated malformed-settings probe returned success without saving or
  warning. Investigate a supported setter/flush result before claiming saved state.
- **Setting scope:** global saves address one worker; other live workers and project overrides may
  differ. Explain that scope in the controls.
- **Usage readability:** context/path fact cells can clip without keyboard/touch access. Current
  context and cumulative usage are different measures; this is not an incorrect-total finding.
- **Startup diagnostics:** a broken extension closes RPC with its useful load diagnostic remaining
  Host-only. Expose a bounded actionable explanation or diagnostic entry.
- **Omitted resources:** trust-skipped resources and invalid skills can disappear unexplained. Keep
  trust with Pi; successful command inventory is not a complete omission diagnostic.
- **Dialog cancellation:** Pi 1.0 extension-owned AbortSignal resolution sends no dismissal event.
  The native probe emitted request and completion only, leaving the Host request retained. Timeout
  and Host Stop cleanup work; model idleness or generic command completion is not a safe substitute.

Sources: `server/{runtime,runtime-slot,pi-rpc,pi-update-checker}.ts`, settings/command/trust/startup
native probes, and desktop/narrow Settings, usage and Reload checks. Persistence-result and loading
interfaces need further investigation.

## Remaining coverage and interface boundaries

- Complete current-worker loaded-extension names in [[interface-preferences]] need a native
  inventory read; `get_commands` omits command-free extensions.
- Generic extension argument completion needs a public Pi interface or explicit adapter. RPC and
  public `ExtensionAPI.getCommands()` omit callbacks/template hints; do not guess per package or
  monkey-patch private handlers.
- Richer reusable GUI components remain open work under [[northstar]]. Pi RPC cannot serialize
  custom TUI components, editor/footer/header renderers, terminal shortcuts or autocomplete callbacks.
  Draft reads return empty text and RPC paste replaces rather than inserts. Dedicated controls
  currently require source changes, not an invented frontend plugin platform.
- [[mcp]] retains conditional graphical configuration/connection management. Pi 1.0.0 exposes no
  public structured runtime-manager interface; the user rejected modifying Pi or requiring a patched
  runtime. Configured MCP tools already execute through Pi.
- Native History labels, secondary filters, fuller keyboard navigation and copy-selected-entry
  remain gaps. Same-session continuation requires idle work, no queues/dialogs;
  independent copies still need healthy materialized current-format sources.
- `/import`, `/share`, `/bug` and `/trust` remain guidance-only, not permanent exclusions.

## Unselected enhancements and design questions

- Read-only reopened usage summaries are absent until worker startup. Any retained-statistics
  enhancement must preserve read-only opening.
- Basic RPC counts and input/output/cache breakdowns are not fully disclosed. Per-model/provider
  costs and cache-warming/re-billing information exceed that RPC result. Useful disclosure is a
  candidate, not a required dashboard.
- Per-model thinking-default editing is absent. Advanced cache/transport/proxy/timeouts, image,
  retry/compaction/thinking budgets, shell/telemetry/trust and tool/resource/package configuration
  remain native file/CLI work. A provenance/resource-diagnostic view is a candidate; TUI-only
  input/display settings need no duplicate browser controls.
- Palette proposals remain undecided: bypass preparation for no-argument resource actions/plain
  Compact, expose a light browse route for infrequent actions, and clarify prepared-editor submit
  keys. Current evidence is in [[follow-command-ux-2026-10-02]].
- Immediate retirement of successful Compact receipts awaits the transcript inventory in
  [[follow-native-command-surface-2026-09-04]]. Files layout questions remain in
  [[follow-file-browsing-experience-2026-08-24]].

## Next actions

Select a remaining interface gap from evidence above, inspect the current public Pi boundary and
implement within the existing surface. Preserve deferred contracts and the distinction between
native limitations, known implementation gaps and unselected proposals.
