---
scope:
  - docdoki/specs/*.md
  - docs/*.md
  - src/**
  - server/**
  - shared/**
  - tests/**
---

# Pi capability gaps

Inspire adapts supported public Pi interfaces under [[northstar]]. The following GUI requirements
remain blocked on owning-worker interfaces; the other ideas below are undecided.
Implemented behavior belongs to [[pi-integration]], [[model-settings]], [[mcp]] and [[composer]].

## Blocked requirements

The gaps below remain in the inspected Pi 1.3.0 public RPC and extension interfaces.

| Requirement | Missing interface |
| --- | --- |
| Cycle the owning RPC worker backward with native scope/default/event ordering | SDK `AgentSession.cycleModel(direction)` exists, but RPC invokes it without a direction. The GUI bridge receives only public extension/command contexts, neither of which exposes cycleModel or the owning AgentSession; `ExtensionAPI.setModel/setThinkingLevel` do not reproduce that event. Previous-model palette/keyboard actions report unsupported; the model picker and forward native cycle remain usable. |
| Report whether a worker-owned settings change reached disk | An attributable persistence result covering both load and write failures. RPC and ExtensionAPI do not expose the worker's settings manager. SDK `flush()` can resolve with drainable errors, while a malformed-at-start file can block writes without a new error. Effective-value rereads do not establish persistence. |
| Explain omitted invalid skills | Current-worker resource identity and omission reason. SDK loader diagnostics belong to that loader; the RPC worker does not expose them. The existing project-trust notice is only a trust restriction notice. |
| Dismiss a particular extension-cancelled dialog | A request-ID-bearing cancellation/resolution event. Aggregate `ui_prompt_start/end`, titles and model idleness cannot identify one of several concurrent prompts. Timeout and Host Stop cleanup already work. |
| List all loaded extensions | An owning-worker inventory that includes command-free extensions, absent from `get_commands`. |
| Complete arbitrary command arguments | A current-worker invocation of registered completion callbacks. `get_commands` and `getCommands()` return metadata; RPC autocomplete registration does not expose callback invocation. |
| Manage loaded MCP servers and tools | Complete structured server/tool/source/auth state and attributable actions on the owning connection. File configuration is implemented; CLI state and generic handled-command receipts do not establish current-worker state. [[mcp]] retains the decided panel requirements. |

Revisit these requirements when Pi provides the corresponding public interface. Do not substitute
another settings manager, resource scan, CLI runtime or private API for the owning worker.

## Open proposals

- **Reusable extension UI:** additional components for permissions, subagents and question panels.
  RPC does not serialize custom TUI components, editor/footer/header renderers, terminal shortcuts
  or autocomplete callbacks. Draft reads return empty text and RPC paste replaces rather than
  inserts. Dedicated GUI controls currently require source changes.
- **History:** labels, secondary filters and fuller keyboard navigation. Selected-entry Copy is
  implemented. Continuation still requires idle work and no queues/dialogs; independent copies
  require healthy materialized current-format sources.
- **Usage:** retained read-only summaries before worker startup and fuller native counts or
  input/output/cache disclosure. Per-model/provider costs and cache-warming/re-billing details
  exceed the basic RPC result. A retained summary must preserve read-only opening.
- **Configuration:** per-model thinking defaults; provenance and resource diagnostics; advanced
  cache, transport, proxy, timeout, image, retry, compaction, thinking-budget, shell, telemetry,
  trust, tool/resource and package settings. These remain native file/CLI work; TUI-only display
  and input settings need no duplicate browser controls.
- **Command palette:** direct execution for suitable no-argument resource actions/plain Compact,
  a light browse route for infrequent actions, and clearer prepared-editor submit keys.
- **Terminal-guidance commands:** further GUI support for `/import`, `/share`, `/bug` and `/trust`.

These proposals are separate from the blocked requirements and are not scheduled implementation.
