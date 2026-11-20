---
scope:
  - src/**
  - server/**
  - shared/**
  - extensions/**
  - scripts/**
  - docs/**
  - tests/**
  - inspire.mjs
specs: [pi-integration, model-settings, composer, host-lifecycle, terminal, tool-presentations]
---

# Quality, Native Capability and Simplification Review

**Baseline:** Inspire `auto-dev`, 2026-11-20  
**Pi baseline:** 1.5.2  
**Status:** Investigation and implementation guidance; recommendations are not all approved implementation requirements.

This document consolidates a review of Pi capability coverage, Extension author experience, and opportunities to simplify Inspire without reducing its established user-facing behavior. It supplements [[northstar]], [[pi-integration]], [[model-settings]], [[composer]], [[host-lifecycle]], [[tool-presentations]] and [[handbook-simplification]].

## 1. Product and engineering direction

Inspire is Pi's graphical interface and workbench, not a separate agent platform.

- Pi and the user's configuration own agent behavior, model tools, prompts, extensions, credentials, and canonical session data.
- Inspire adapts Pi through supported public interfaces and provides the browser workbench, Host services, and selected supporting capabilities.
- Extensions own their business logic and may use Inspire's optional reusable UI components. They are never required to use them.
- Keep the existing product behavior and interaction model unless a change has a clear user-facing reason.
- Prefer deleting redundant mechanisms over adding abstractions, compatibility layers, defensive state, or configuration surfaces.
- Follow the latest supported Pi release. Do not maintain an open-ended compatibility matrix for older Pi versions. Keep only the startup checks needed to explain a genuinely incompatible installation.
- Native state consistency is already a relative strength. Fix demonstrated residual inconsistencies, but do not add another general-purpose reconciliation framework.
- The high-frequency `auto-dev` branch intentionally does not run full CI on every push. Preserve that policy.

This is a review guide, not a quota-driven rewrite. A shorter implementation is not automatically better; complexity that protects a real ownership, persistence, delivery, or recovery boundary should remain.

## 2. Pi 1.5.2 capability audit

Sources:
- [Pi 1.5.2 RPC command reference](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/rpc-commands.md)
- [Pi 1.5.2 Extension API reference](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/extensions.md)
- [Pi 1.5.2 release](https://github.com/earendil-works/pi/releases/tag/v1.5.2)

The checkout pins `@earendil-works/pi-coding-agent` 1.5.2 for development, while production resolves the user's installed Pi runtime. The audit below describes the inspected `auto-dev` implementation against the v1.5.2 public documentation. Recheck the relevant source path before implementing: this is a point-in-time audit, not a promise that every command must be called directly.

### 2.1 Covered directly or through a deliberate alternative

| Pi capability | Inspire path | Assessment |
| --- | --- | --- |
| `prompt`, steering and follow-up | Prompt RPC; streaming behavior carries steer/follow-up intent | Covered |
| `abort`, `clear_queue`, `get_state` | Runtime input and stop lifecycle | Covered |
| `set_model`, `cycle_model`, `get_available_models` | Native RPC and model catalog | Covered; previous-model cycling is not exposed by the current RPC adapter |
| `set_thinking_level` | Native RPC | Covered |
| `set_steering_mode`, `set_follow_up_mode` | Native RPC | Covered |
| `compact`, `set_auto_compaction`, `set_auto_retry` | Native RPC / Pi-owned settings | Covered |
| `bash`, `abort_bash` | Native RPC and dedicated Bash lifecycle | Covered |
| `get_session_stats`, `export_html` | Native RPC | Covered |
| `get_entries`, `get_commands`, `set_session_name` | Native RPC | Covered |
| Session creation and switching | Independent Inspire-owned Pi workers and Host session selection | Deliberate architecture; not a missing feature |
| `get_messages`, `get_tree`, `get_last_assistant_text` | Session Projection and local branch/history reads | Deliberate projection-based alternative |
| `fork`, `clone`, `get_fork_messages` | Pi SDK `SessionManager`, staged fork worker, and local projection | Deliberate alternative; preserve Pi's session semantics |
| `steer` / `follow_up` as separate RPC commands | Encoded as prompt streaming behavior | Deliberate protocol usage |

Do not add duplicate RPC reads merely to mirror the command list. The Host's projection is valuable where it provides bounded, branch-aware, reconnectable history and avoids competing session authorities.

### 2.2 Small, high-value gaps

#### Abort an automatic retry

**Priority: high. Implementation cost: low.**

Pi 1.5.2 exposes RPC `abort_retry`. The current adapter already projects retry state and exposes retry settings, but the inspected `server/runtime.ts` does not dispatch this command.

Add a small action for the active retry state and route it to the owning RPC worker. Let Pi's response and subsequent state observation determine the final UI state. Do not invent a second retry state machine or optimistically claim that retry has stopped.

This is an Owned Worker capability. Do not pretend an attached terminal Pi can be controlled through an API it does not expose.

#### Use Pi's native thinking-level cycle for Owned Workers

**Priority: medium-high. Implementation cost: low.**

Pi 1.5.2 exposes `cycle_thinking_level` and `get_available_thinking_levels`. The current browser `cycleThinking()` derives the next level from model metadata and calls `setThinkingLevel()`.

For an Inspire-owned RPC worker, prefer the native cycle command and native available-level query. This keeps cycling order and model-specific defaults with Pi. For an attached TUI where the public extension API does not expose the equivalent operation, retain the existing setter-based path rather than inventing a private control channel.

Do not expand this into a broad rewrite of model settings.

### 2.3 High-value additions that need more than a trivial RPC call

#### Tool Loadout

**Priority: high. Implementation cost: moderate.**

Pi's public Extension API exposes `pi.getActiveTools()`, `pi.getAllTools()`, and `pi.setActiveTools(names)`. Inspire's current Tool Presentations configure how tools are displayed; they do not manage which tools are offered to the model. These are separate concerns.

A lightweight Tool Loadout surface would let users inspect and toggle tools for the current worker. It should:
- show active and available tools with useful descriptions and source information;
- use Pi's `exposure` and related metadata rather than treating every registered tool as a simple toggle;
- preserve Pi's semantics for `hidden`, `codemode`, `deferred`, and dynamically registered tools;
- keep tool execution and registration inside Pi;
- use the existing internal Extension Bridge pattern only if it remains the simplest supported way to query and change the owning worker;
- avoid creating a second tool registry, policy engine, or saved configuration system unless a concrete user need requires it.

This is a promising product enhancement, not a prerequisite for a correct Wrapper. Validate the interaction with a real extension that dynamically registers tools before broadening it.

#### Fork a session into a new workspace when its original workspace is unavailable

**Priority: medium-high. Implementation cost: moderate.**

The current `copyBranchInside()` rejects a source whose workspace is unavailable, and the staged fork uses the source session's `cwd`. This is an Inspire workflow restriction, not evidence that Pi's RPC is missing a `fork` command.

Consider allowing the user to choose a destination workspace for a Fork when the original directory has disappeared or moved. Preserve the existing staged-copy and atomic publication boundaries, source fingerprint checks, and Pi `SessionManager` semantics. Do not change the source session or silently choose a destination.

Treat this as a targeted recovery improvement. It should not become a general-purpose workspace migration feature.

### 2.4 Pi capabilities not worth reproducing in the browser now

These interfaces are either TUI-specific, not exposed to the owning RPC worker in a suitable form, or low enough in value that a custom implementation would cost more than it returns.

| Capability / request | Why defer |
| --- | --- |
| TUI Header/Footer, working indicator, editor component, hidden-thinking label, terminal theme | Browser chrome, composer, activity and theme are already owned by Inspire. Recreating TUI rendering semantics adds little value. |
| Terminal shortcut registration and raw terminal input handlers | Browser shortcuts need focus, editor, modal and platform ownership. Expose a purposeful Inspire action only when a real workflow requires it. |
| Arbitrary extension command-argument completion callbacks | RPC exposes command metadata, not a general safe invocation of each callback. Keep normal command completion; defer the generic callback bridge. |
| TUI message and entry renderer functions | Functions/components are not serialized over RPC. Use an optional Web adapter or declarative display rather than attempting to execute TUI renderers in the browser. |
| Exact dismissal of one extension-cancelled dialog | The public aggregate prompt-end event has no request ID. Do not infer which of several concurrent dialogs ended. |
| Complete loaded-extension inventory | Command inventory misses command-free extensions; a new worker inventory is needed. Low immediate user value. |
| Detailed reasons for every omitted invalid skill/resource | Requires attributable current-worker loader diagnostics. Do not run a second loader or filesystem scan to guess. |
| Live MCP server/tool/auth management | Current file-backed MCP configuration is useful. Accurate live management needs owning-worker state and attributable actions; avoid a parallel MCP runtime. |
| Reading or inserting arbitrary current editor text through Pi RPC | RPC returns empty/undefined for TUI editor access and paste semantics differ. The Inspire composer remains its own authority. |

The guiding rule is not “implement every Pi Extension API in the browser.” Implement the capabilities that translate naturally into a useful browser workflow. Leave terminal-specific capabilities in Pi's terminal.

## 3. Extension author experience and reusable UI

[[northstar]] already commits Inspire to documentation, reusable UI components, and examples for permissions, subagent management, and question panels. This review turns that direction into an implementation guide; it does not introduce a requirement that extensions depend on Inspire.

### 3.1 Desired boundaries

Keep three concerns separate:

1. **Extension logic:** Pi extension owns state, commands, tools, permissions, persistence and lifecycle.
2. **Optional Web adapter:** translates the extension's own state and admitted actions into a browser-facing contract.
3. **Reusable UI components:** present data and report user intent through props and callbacks.

A reusable component must not depend on the global AppStore, a specific Pi worker, or a particular extension's business logic. Runtime identity, authorization, request ownership and transport remain outside the visual component.

### 3.2 Component coverage

Build a coherent reusable set, not an exhaustive component catalogue in one pass.

| Group | Useful primitives |
| --- | --- |
| Layout | Stack, Card, Section, Tabs, Divider, Split |
| Form | TextField, TextArea, Select, Checkbox, Switch, RadioGroup, NumberField, Form |
| Feedback | Dialog, Confirm, Notice, Status, Progress, Loading, EmptyState |
| Content | Markdown, Code, Table, List, KeyValue, Badge, Image |
| Extension patterns | Permission prompt, Question panel, Task list, Subagent/status card |

Start from the repeated needs demonstrated by existing extensions and examples. Add components when they remove duplicated implementation or make an important workflow substantially easier. Do not implement every item merely because it appears in this table.

### 3.3 Two optional extension paths

- **Declarative UI:** structured, bounded data describing common panels, forms, tables, lists and status. Inspire renders it with its components.
- **Custom Web adapter:** an extension author supplies their own browser-side view and adapter for richer or specialized interaction.

An extension that uses neither path must continue to work through Pi's normal tools, commands and native RPC UI primitives.

Do not execute arbitrary extension JavaScript inside the Host or grant a browser component implicit access to Host capabilities. Adapter actions must be explicit, attributable, and checked against the current session/worker and command inventory. Keep the protocol small and serializable.

### 3.4 Packaging and migration

Do not rush to publish a standalone npm package. First establish stable component boundaries inside the repository, document supported props and interaction contracts, and use them in at least one real example. Extract or publish a package only when the dependency boundary and release lifecycle are justified.

Reuse existing `ExtensionDialogContent` and `ExtensionDisplays` work where it fits, but do not mistake an internal component import for a finished public component system.

The task-board example and native UI example should demonstrate the supported patterns. Keep the examples optional and independent of Inspire's main product UI.

## 4. Native state consistency and Pi version policy

### Native state consistency

The current design already has clear ownership in important areas:
- Pi owns runtime settings and execution.
- RuntimeSlot and the Host own worker lifecycle and operation admission.
- Session files own durable history.
- Projection observes and presents persisted state.
- Browser snapshots/events project Host state rather than becoming a second runtime authority.

Do not add a global reconciler or duplicate state store. When a concrete mismatch is found, identify the authoritative owner and repair the specific boundary. Preserve the distinction between accepted input, completed operation, persisted state, and confirmed worker retirement.

### Pi version policy

Follow the latest supported Pi release. Do not maintain old-version compatibility branches or a broad version matrix. Keep:
- one current development pin;
- runtime discovery of the installed Pi package;
- direct checks for the public APIs Inspire actually calls;
- a clear startup failure when a required API is absent.

Remove compatibility branches only after confirming they do not protect a currently supported installation or a real deployment transition. Do not add fallback layers for hypothetical old versions.

## 5. Simplification findings

The largest opportunities are not “large files must be split.” They are places where one workflow owns too many concerns, the same fact is maintained in multiple places, or abstractions obscure rather than clarify ownership.

### 5.1 Highest-priority review: Prompt Delivery

**File:** `server/runtime.ts`, especially `promptInside()` and its delivery path (around lines 2842–3350 at the reviewed revision).

The method combines session/branch ownership, attached-session dispatch, command routing, artifact preparation, project-file resolution, pending-image recovery, admission, RPC delivery, and settlement/cleanup.

This is the strongest candidate for a focused simplification pass.

Recommended approach:
- map the actual lifecycle and identify which object owns each piece of state;
- separate preparation from the irreversible delivery boundary and settlement;
- consolidate genuinely repeated validation and cleanup;
- make the delivery owner and its captured session/view/stop identity explicit;
- keep a single clear path for equivalent Owned Worker delivery; retain a distinct Attached Pi path only where ownership or protocol semantics differ;
- prefer a small cohesive module or a few local functions over a chain of single-use classes and callback-forwarding helpers.

Preserve:
- Stop/input race protection and stop epochs;
- stale branch/view rejection;
- no automatic duplicate delivery after an unknown outcome;
- attachment and image recovery after confirmed non-delivery;
- native Pi confirmation as the source of execution truth;
- current behavior for queued input and extension hooks.

Do not pre-commit to a line-deletion target. The lifecycle is real; the task is to remove duplicated coordination and make ownership easier to follow.

### 5.2 AppStore and browser controllers

**File:** `src/store.ts`.

AppStore is intentionally the browser's single state publication authority. Existing Workspace, Resource, Git, Branch, Composer, Selection and Notification controllers already own meaningful request lifecycles.

Do not split the application into multiple competing stores or extract more controllers solely to reduce the file length.

Review:
- callback-heavy `state()` / `patch()` / `api()` plumbing that only forwards values;
- duplicate request ownership, generation checks or error handling;
- state retained in AppStore after a controller became its real owner;
- multiple representations of the same UI fact.

Keep controller boundaries where they own a real asynchronous lifecycle or domain operation. Collapse pass-through layers that add no ownership.

### 5.3 Host lifecycle and restart

Relevant modules include `inspire.mjs`, `server/instance-state.mjs`, `server/instance-control.mjs`, `server/launcher-restart.mjs`, `server/host-restart.ts`, `server/host-restart-backend.ts`, and `deploy/systemd/control.mjs`.

There are several control transports: authenticated local HTTP, a shutdown-request mailbox, launcher/Host IPC, and systemd operations. They serve different scopes and environments; do not unify their wire formats merely for visual consistency.

Review for:
- duplicate representations of Host identity or restart intent;
- repeated submission/settlement logic across restart backends;
- redundant status reads or receipt layers;
- wrappers that only relay a call without owning policy;
- duplicated process/service identity checks.

Preserve PID-reuse protection, process-start identity, service ownership checks, restart commit confirmation, and unknown-outcome handling. Never simplify an uncertain restart into an ordinary retry.

### 5.4 Session Projection

**File:** `server/session-projection.ts`.

This module has substantial inherent complexity: JSONL integrity, incremental scanning, branch indexing, transcript projection, paging, and reconciliation.

Do not rewrite or split it by line count. Inspect whether the same branch/session data is indexed or materialized repeatedly, whether caches duplicate authoritative data, and whether transcript/history projections repeat work that can share a stable representation.

Preserve file identity, incomplete-tail handling, rewrite detection, branch semantics, bounded pages and source integrity checks.

### 5.5 Other modules

| Area | Review direction |
| --- | --- |
| `server/app.ts` | Check route handlers for repeated endpoint plumbing and duplicated business logic. Do not build a route framework or split files just to group URLs. |
| `server/terminal-session-manager.ts` | Keep as a real subsystem. Inspect duplicated lifecycle state and terminal replay representations, but preserve PTY ownership, reconnect, scrollback, shell integration and platform behavior. |
| `server/pi-rpc.ts` | Keep strict framing, request correlation and unknown-outcome semantics. Simplify only demonstrably duplicated transport logic. |
| `server/operation-receipts.ts` | The shared ReceiptWindow already serves Host and Terminal receipts. Preserve this real reuse; avoid another generic receipt abstraction. |
| `server/runtime-pending-images.ts` | Complex recovery reflects a real uncertain-delivery problem. Simplify only after mapping the delivery evidence and ownership transitions. |
| `scripts/verify-release-package.mjs` | Keep real package-install, Pi, Host, PTY and restart validation. Do not replace it with shallow file-existence checks. |

### 5.6 Common deletion candidates

Look for these patterns across the repository:
- dead code, unused exports, stale branches, obsolete feature flags and abandoned migration paths;
- duplicate state that can be derived from an existing authoritative object;
- repeated parsing, validation, projection or serialization with identical semantics;
- one-implementation interfaces, factories and registries that add indirection without an extension point;
- wrappers that only pass arguments through;
- fallback paths for unsupported old Pi versions;
- defensive checks whose precondition is already guaranteed by the owning boundary;
- synthetic tests that repeat a real test at the wrong layer;
- generated, vendored or copied assets that are no longer needed.

Do not delete code solely because it is defensive. Every deletion should be justified by an ownership invariant, a proven duplicate, or an obsolete requirement.

## 6. Code-size expectations and measurement

### 6.1 Do not treat the previous estimate as a measured baseline

The earlier discussion gave a rough estimate of approximately 111k production lines and proposed 70–90k production lines plus 50–60k test lines as a possible target. Those figures were extrapolated from file counts and byte sizes, not produced by a reproducible line-count tool. They are **low-confidence planning estimates**, not verified repository metrics.

Before setting a hard target, establish a reproducible baseline on the exact commit. Count tracked source files and lines by category, excluding generated build output, minified bundles, vendored code, fonts, snapshots and other non-authored artifacts. Report production, tests, scripts, styles and documentation separately. Record the command and commit SHA so the comparison can be repeated.

### 6.2 Working expectation

For the current product scope, a production-code range around **70–90k authored lines** is a reasonable hypothesis to test, not a quota. The test suite should be sized by the behaviors and failure boundaries it needs to guarantee; do not impose a separate numeric deletion target on tests.

If a trustworthy baseline confirms the project is materially above that range, investigate the largest sources of avoidable complexity first. If it is already near the range, do not keep deleting to reach an arbitrary number. A correct implementation of Pi integration, Session/Branch persistence, Host lifecycle, terminal, file browsing, Git, remote access and browser UI necessarily has a nontrivial size.

### 6.3 What should reduce code size

Expected reductions should come from:
- removing duplicated state and repeated workflow logic;
- collapsing pass-through abstractions;
- deleting obsolete compatibility and fallback paths;
- consolidating equivalent lifecycle handling;
- removing duplicate tests and fixtures after coverage is mapped.

Do not count moving code into more files, replacing handwritten code with generated code, or hiding logic in a generic framework as simplification.

## 7. Test strategy and CI policy

Keep tests at the layer that owns the behavior:

1. Unit tests for pure logic, parsers, projections and state transitions.
2. Integration tests for Pi RPC, Host, process, filesystem, Session and PTY boundaries.
3. Browser tests for real user workflows, keyboard/touch behavior, layout and accessibility.

A unit test and a browser test are not duplicates merely because they exercise the same feature. They answer different questions. Remove tests when they repeat the same contract at the same layer, test implementation details, or rely on synthetic assumptions already covered by a stronger integration test.

Preserve real Pi, filesystem, process, PTY, uncertain-delivery, restart and browser fault cases. Do not delete tests simply because they are long or have similar names.

**CI policy:** `auto-dev` intentionally does not run full CI on every push because its commit/push frequency is high. Keep that behavior. Use deliberate verification during development, CI on the integration/release path, and the existing release-package verification before shipping. Do not add expensive per-push jobs to auto-dev.

## 8. Product communication

Do not market Inspire through a feature-by-feature comparison with Pi Web or another product. Explain Inspire on its own terms:
- what it is and how it fits into a Pi workflow;
- the workbench and browser/remote access experience;
- how it works with existing Pi configuration, extensions and sessions;
- how extension authors can add optional browser experiences.

Use a short real workflow demonstration rather than a competitor comparison table.

## 9. Suggested execution order

1. **Small native gaps:** implement `abort_retry`; use native `cycle_thinking_level` and `get_available_thinking_levels` for Owned Workers.
2. **Tool Loadout investigation:** prototype the smallest useful UI using the public Extension API and existing bridge conventions. Keep it small; decide after a real extension test.
3. **Fork recovery:** design the smallest explicit destination-workspace flow for unavailable source workspaces.
4. **Extension UI foundations:** define component boundaries and documentation, then implement the highest-reuse primitives and one complete example. Keep adoption optional.
5. **Prompt Delivery simplification:** map ownership, consolidate duplicate coordination, and reduce the large method without changing delivery semantics.
6. **Store and Host audits:** remove pass-through layers and duplicated state where evidence supports it.
7. **Projection and Terminal review:** investigate repeated data/index work; preserve their real lifecycle boundaries.
8. **Test cleanup and measurement:** establish an exact line-count baseline, remove proven duplicate coverage, and compare behavior and source size.

These workstreams can be reordered when implementation evidence changes the cost/benefit picture. Do not bundle unrelated refactors into one large change.

## 10. Acceptance criteria

A simplification pass is successful when:
- existing user-facing workflows and interactions remain intact unless a deliberate product change was agreed;
- Pi remains the authority for agent behavior, execution and native settings;
- session, branch, attachment, pending, terminal and Host ownership boundaries remain clear;
- uncertain outcomes are represented honestly and cannot cause duplicate mutations;
- duplicate state, repeated logic and pass-through abstractions have been removed;
- tests still cover real behavior at the owning layer, without relying only on tests that mirror the implementation;
- the authored-code baseline is measured reproducibly before and after;
- no old-version compatibility matrix, generic reconciliation framework, or mandatory Extension SDK has been introduced without a demonstrated need.

The goal is not the smallest possible codebase. It is the smallest clear implementation that preserves Inspire's intended capabilities and reliability.
