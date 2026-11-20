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
**Status:** Review and implementation record. Section 11 records the decisions and verification.

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

#### Stop during automatic retry

Pi's existing `abort` cancels automatic backoff. Inspire's Stop also returns pending input to
the draft. `abort_retry` would cancel the wait while leaving the queue with Pi. That narrower
operation has no performance benefit and does not justify a separate control. Use Stop.

#### Use Pi's native thinking-level cycle for Owned Workers

**Priority: medium-high. Implementation cost: low.**

An Inspire-owned worker uses `cycle_thinking_level` to keep cycling order and defaults with
Pi. The picker already has the model metadata used by Pi's `get_available_thinking_levels`.
An attached Pi uses the public setter for the same gesture.

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

Use disposable probes for investigation and feature verification by default. Keep a new test
when it protects a consequential regression that existing coverage can miss.

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

1. **Small native gaps:** verify Stop during retry. Use native `cycle_thinking_level` for Owned Workers.
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

## 11. Implementation and review results

### Implemented product behavior

- **Stop and thinking.** During provider retry backoff the ordinary Stop action interrupts Pi. A disposable real-Pi check continued the same worker with a fresh prompt after a 503. Owned workers cycle thinking levels through Pi RPC. An attached worker uses Pi's thinking setter. See [[model-settings]].
- **Tool Loadout.** The session menu and palette read the active worker's tool inventory. A change carries one name and desired value, is bound to the observed worker and view, and publishes Pi's confirmed selection. Extension exposure hooks can change what the provider receives. See [[pi-integration]].
- **Workspace recovery.** Fork into another folder copies the whole saved tree into the selected existing workspace and opens an empty editor. An on-disk regression checks that alternate branches survive. The source retains its file and draft. See [[session-branches]].
- **Extension UI.** Source extensions can reuse the question body, EmptyState, ToggleSwitch, modal and display components while owning their own state. The native question dialog and task board exercise these interfaces. See the [extension guide](../../docs/extensions.md#reusable-components-in-a-source-checkout).
- **Writer and history.** An owned prompt's upload lease settles before the next queued prompt gets the writer. An accepted attached-Pi prompt can finish local cleanup after the reply. Disposable 20,000-entry sessions checked direct prompt recall, append-index reuse, failed-append rollback and publication at the native seal. Browser Stop, compaction and lost receipts still exercise distinct delivery outcomes.

### Deep deletion pass from `f02a6757`

The comparison uses the exact opening tree of the pass, `c62a2694b128675a32a49d13e53ba474811eac0d`. The reproduction command uses that tree directly.

| Tracked authored material | Before lines | After lines | Change | Files before → after |
| --- | ---: | ---: | ---: | ---: |
| Production source | 108,927 | 107,743 | −1,184 | 463 → 456 |
| Test source and fixtures | 76,733 | 76,630 | −103 | 375 → 373 |
| Styles | 12,815 | 12,815 | 0 | 28 → 28 |
| Development and build scripts | 2,321 | 2,321 | 0 | 23 → 23 |
| Documentation examples | 492 | 492 | 0 | 5 → 5 |
| Markdown including this report | 10,171 | 10,112 | −59 | 56 → 56 |
| **Total** | **211,459** | **210,113** | **−1,346** | **950 → 941** |

#### Ownership and deletion

- **Runtime and prompt delivery.** Removed `runtime-reads.ts`, `runtime-projection-coordinator.ts` and `runtime-worker-pool.ts`. Reads, subscriptions and reclamation share Runtime's slot registry. The 24 `server/runtime*.ts` files fell from 11,029 lines to 10,401 across 20 files. Within that group `runtime.ts` grew from 5,016 to 5,134 as it took ownership. Four late configuration setters became startup inputs. Owned and attached Pi now share upload staging, history authorization, project-file revalidation and native prompt construction. Owned delivery still settles leased uploads inside its writer queue. The attached endpoint can confirm acceptance before local cleanup completes. Measured from the declaration through its closing brace, `promptInside` fell from 454 to 427 lines.
- **Worker and view state.** A RuntimeSlot owns the session path, branch revision, history index and effective leaf. Opening a saved session and adopting a Fork use the same path. The external receiver checks the actual branch ancestry when it attaches. The worker event queue and the projection each have one promise to drain.
- **Worker events.** Removed the single-reply command wrappers `runtime-retry-state.ts`, `model-catalog-refresh.ts` and the server-side `provider-auth-bridge.ts`. One authenticated worker-status exchange checks the worker, session, nonce and reply count. The Pending evidence stream still accepts multiple packets. Removed `herdr-worker-observer.ts` and two worker registries. An enhanced process reports to its own pane, coalesces writes and can report the same state again after a failed write.
- **Session projection, Fork and resources.** History image reads locate the entry and block through the branch index. The image label still follows its chronological ordinal. Fork indexes the staged destination once. After atomic publication under reservation, it verifies the hard link, committed bytes and complete tail before attaching that projection. The resource store keeps one citation-index promise per session and visible revision. Context reads check ownership again after reconciliation. Canonical paths and authorized outside-workspace citations still govern file access.
- **Workbench.** Removed 65 `AppStore` members, including 61 forwarding methods, three delivery aliases and a fixture-only text setter. Views call the owning controller. AppStore still publishes snapshots and coordinates cross-domain changes. `store.ts` fell from 3,139 to 2,909 lines. Recalled attachments share their source scope. TerminalView uses one live props reference, and the branch outline uses the DOM's scroll position. Native tool cards and citation extraction share the parser for tool argument paths.
- **Attachments and Pending.** The upload store owns sizes, content and descriptors. Prompt reads and image previews share its bounded read. Pending deliveries carry the image IDs, copied IDs and native evidence needed to distinguish an already-consumed image from one still recoverable after a lost reply. Three terminal delivery labels with identical behavior became one released state. Upload lease states retain their distinct outcomes.
- **Host, Terminal and Git.** The launcher preflight delegates to the same installation that the Host starts. Authentication uses one attempt registry. Restart status reads its latest retained operation. In-process terminals call their service directly. Daemon IPC still validates untrusted frames. Pending, retained and retired operation receipts have disjoint ownership. Terminal tabs persist in the order of the session map and restore legacy order lists. Git porcelain parsing and worktree lookup share one raw-path map, including renamed and non-UTF-8 paths. HTTP model routes and Runtime share the same project catalog.

The table counts independent mutable holders for the listed facts. Getters, immutable inputs and wire responses are outside this count.

| State observed | Before | After |
| --- | --- | --- |
| Terminal tab order | session registry and project order lists | ordered session registry |
| Terminal service connection | pending connection and connected service | connection promise |
| Host restart status | receipt registry and current-operation field | ordered receipts |
| Provider login attempt ownership | attempts and owners | attempts with their endpoint |
| Read-only model discovery per slot | observed metadata and pending-read registry | one revision-tagged observation |
| Pending image evidence baseline | cursor and pending-read promise | cursor promise |
| Citation cache ordering | index registry and generation counter | per-session registry in access order |
| Git porcelain file identity | file array and map keyed by raw path | one raw-path map |
| Live transcript rows | message list, parallel byte-count list and finished-evidence map | bounded rows with message, byte count and checkpoint evidence |
| Ordered native events | busy-slot set and per-slot promise | pending event promise on the slot |
| Projection observer completion | slot observer promise and projection reconciliation promise | projection reconciliation promise |
| Host stream flush | pending batch and independent timer | timer owned by its batch |
| Browser render flush | pending visual update and independent timer | timer owned by its update |
| **Independent holders in these 13 groups** | **27** | **13** |

#### Verification and remaining size

The test tree has 298 suite files, down from 300. The old BranchController suite checked a synthetic host. Its distinct navigation, history-image, fork/clone, authentication and stale-attachment cases now run through the real AppStore, HTTP client and socket events. The removed RuntimeReads suite mutated fake slot fields. The real workspace restoration test checks stale message and image access. Disposable probes also exercised an append during a resource read, reclamation and reopen of the same session, and malformed or empty recalled image data. Upload and base64 tests cover the retained byte-validation boundary. The browser file-search case now checks both an explicit failure and a successful empty result.

A disposable Runtime probe supplied 2,000 native text fragments of 32 characters. Both snapshots reconstructed 64,000 characters. Full assistant records accompanying the internal fragment events fell from 2,000 to zero. The JSON size of those Runtime-to-Host events fell from 65,052,339 to 665,446 bytes. WebSocket traffic and elapsed time are separate measurements. Both the Host and the browser now combine only consecutive revisions. A reconnecting browser receives fragments after its snapshot sequence, and a clipped message supplies a full replacement.

Vitest passed 1,659 tests with eight skips. Chromium passed all 132 browser scenarios on the packaged web build. The portable suite passed 59, and the launcher suite passed three with one platform skip. The Linux release check installed the production tarball, used external Pi 1.5.2 and exercised the CLI, maintenance, Fork, recovery, PTY output and restart. TypeScript, Biome, Knip and the DocDoki validator passed.

The small-file inventory used a strict 1,800-byte cutoff. Before this pass, all 121 JS/TS files below that cutoff under `src`, `server`, `shared` and `extensions` totaled 3,757 lines. The corresponding totals are now 118 files and 3,629 lines. Single-consumer files include actual process entry points, Windows and POSIX terminal file-URL decoding, and Pi's virtual-model selection rules. Combining those files alone would leave the underlying code.

The largest remaining design questions concern who owns the delivery receipt across the browser, Host and Pi, and when a native worker checkpoint can replace the live transcript overlay. A submitted prompt can outlive its HTTP connection. A native leaf can advance before the JSONL append. Removing one of those representations requires a protocol supplying those facts at the right time. For Terminal, replay bytes, a reconnectable screen and per-client offsets answer different questions. For tool presentations, native Pi output and custom grouped search results have different input grammars. This pass removed 1.09% of production source. The inspected mechanisms do not establish a further 10,000–20,000-line saving with the current guarantees.

<details>
<summary>Reproduce the physical line counts</summary>

Run from the repository root with Python 3. The archive limits the count to tracked files at
the named revision. Classification excludes package locks, generated font declarations, build
output, and binary assets.

```sh
python3 - c62a2694b128675a32a49d13e53ba474811eac0d 55b7b65da0 <<'PY'
from collections import Counter
from pathlib import PurePosixPath
import subprocess
import sys
import tarfile

source = {'.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.sh'}
generated = {
    'src/assets/fonts/flux-mono-sc/flux-mono-sc.css',
    'src/assets/fonts/ibm-plex-sans-sc/faces.css',
}

def category(name):
    root = name.split('/', 1)[0]
    suffix = PurePosixPath(name).suffix
    if name in generated:
        return None
    if suffix == '.md':
        return 'Markdown documentation'
    if root == 'tests' and suffix in source | {'.css', '.html'}:
        return 'Tests and source fixtures'
    if suffix == '.css':
        return 'Styles'
    if root == 'docs' and suffix in source:
        return 'Documentation examples'
    if name in {'inspire', 'inspire.mjs', 'index.html'} or (
        root in {'server', 'shared', 'src', 'extensions', 'public', 'connections', 'deploy'}
        and suffix in source
    ):
        return 'Application'
    if name.endswith('.config.ts') or (
        root in {'scripts', '.github'} and suffix in source | {'.yaml', '.yml'}
    ):
        return 'Development and build scripts'

for revision in sys.argv[1:]:
    counts = Counter()
    files = Counter()
    with subprocess.Popen(['git', 'archive', revision], stdout=subprocess.PIPE) as git:
        with tarfile.open(fileobj=git.stdout, mode='r|') as archive:
            for entry in archive:
                group = category(entry.name) if entry.isfile() else None
                if group:
                    files[group] += 1
                    counts[group] += len(archive.extractfile(entry).read().splitlines())
        if git.wait():
            raise RuntimeError(f'Cannot archive {revision}')
    print(revision)
    for group, count in sorted(counts.items()):
        print(f'{group}: {count:,} lines in {files[group]} files')
PY
```

</details>

### Second pass from `55b7b65da0`

To reproduce these counts, pass `55b7b65da0` and the commit that introduced this subsection to the counting script above. The Markdown count includes this report.

| Tracked authored material | Before | After | Change |
| --- | ---: | ---: | ---: |
| Production source | 107,743 | 107,397 | −346 |
| Test source and fixtures | 76,630 | 76,635 | +5 |
| Markdown | 10,112 | 10,136 | +24 |
| Styles, development scripts and documentation examples | 15,628 | 15,628 | 0 |
| **Total** | **210,113** | **209,796** | **−317** |

- **Worker checkpoint.** The Host and extension share branch request and result schemas. A boolean seal replaced three equivalent seal names. The unused run counter and its event hooks were removed. On Pi 1.5.2 a valid image occupying 12,582,912 base64 characters yielded matching evidence through both transports. With 70 image entries and no JSONL file yet, the bridge delivered all 73,415,021 bytes in 1,192 frames across two batches. Native `get_entries` exceeded the 34,603,008-byte RPC line limit and the worker became unavailable. Replacing the bridge would need bounded native reads and a way to distinguish reloaded contexts.
- **Prompt delivery.** A queued Steer or follow-up keeps its admitted worker across upload and file authorization. Replacing that worker returns 409 and makes the staged upload available again. The writer queue settles uploads before yielding to the next delivery. Idle extension commands read the command inventory once. Pi still owns queued image order. A linear scan matched the previous removal result on 132,496 queue pairs, including duplicate captions. Removing the last of 1,024 items took 1,024 caption reads, down from 1,047,552.
- **Composer.** Per-session receipts replaced draft-to-receipt links, submitted-file markers and a global delivery revision. The still-open browser tab can recover its image from a later receipt if the initial response is lost. A consumed handoff cannot revive an image the user has since removed. An existing lost-response test now covers the returned image.
- **Session history.** The current branch reuses published message objects until it contains a compaction. Branch listing uses the route index for the total and stops after the 30 newest leaves. A comparison with the baseline reused 10,000 message objects and matched four history queries across eight leaf selections, three compactions and 45 branch tips. Saved-file and worker indexes retain independent cursors, so native rows can precede JSONL without becoming durable.
- **Terminal and Host.** The Host consumes the TLS stream directly, removing its second frame queue and attachment publication state machine. The daemon lease references the live attachment. A real shell kept its PID across client replacement, executed a repeated input sequence once, and reattached through both delta replay and a snapshot after 8,500,115 bytes of detached output. Host restart confirmation, process identity checks and daemon operation receipts still cover separate failure boundaries.

The production reduction fell below the review's 400–900-line estimate. The proposed native checkpoint replacement accounted for 120–200 estimated lines. Pi's unbounded response prevents that replacement for sessions with large unpersisted image entries. The two largest remaining areas depend on Pi exposing bounded session reads and stable pending-image identities. Neither is available in the tested protocol.

Verification covered 1,659 Vitest tests (8 skipped), 59 portable tests, 3 launcher tests (1 skipped), 132 Chromium scenarios and the installed release package. After limiting the history reuse check to the selected branch, 17 history/projection tests, all 3 Chromium history scenarios and the package smoke passed again. The retained suites cover full-tree Fork, native queue recovery and Host restart with a live terminal. The four checkpoint test files changed only their private wire fixtures. No test cases were added or removed. Investigative probes were discarded.
