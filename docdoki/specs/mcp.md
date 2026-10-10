---
purpose: Present publicly supported Pi MCP configuration and session controls in compact Settings, deferring capabilities whose native interfaces are unavailable.
progress: not-started
covers:
  - server/mcp*.ts
  - server/extensions/*mcp*.ts
  - shared/*mcp*.ts
  - src/components/*Mcp*.tsx
  - tests/server/*mcp*.ts
  - tests/web/*mcp*.tsx
  - tests/browser/*mcp*.ts
---

# MCP management

## Goal

Add compact MCP configuration and connection controls to Settings. Pi owns connections, credentials,
tool policy and execution. File configuration can use existing Pi files/CLI; the complete current-worker
management panel awaits public runtime interfaces.

- Default server rows show name, understandable runtime state and a relevant action. Configuration,
  searchable tool inventory and diagnostics open on demand.
- Add/edit forms start with name, configuration target and HTTP URL or stdio program/arguments.
  Environment, headers, timeout and exposure settings are advanced controls. Preserve fields outside
  the edited subset and do not return stored or resolved authentication secrets to the browser.
- Distinguish configuration source and precedence from the addressed project's/session's loaded
  state. Native extension-registered servers retain their source and native mutation semantics.
- Login/logout/reconnect operate through the owning native runtime. An independently connected CLI
  process is not evidence of that runtime's connection state.
- File configuration saving and application are distinct. Offer existing explicit reload behavior
  when needed, without permanent extra status on every row or a silent worker replacement.
- Native enable/exposure controls retain their direct runtime behavior where supported.
- An attributable connection error can navigate to the relevant settings; navigation is not labeled
  as an already-completed repair.
- Tool inventory is searchable and bounded. No tool-execution console, MCP Apps renderer or generic
  compatibility framework is included. Replacement MCP implementations need their own explicit
  adaptation rather than assumed native controls.

## Interface boundary

MCP tool execution and Codemode composition already work. File configuration editing is not
interface-blocked, but its GUI is not implemented. The missing current-worker capabilities are:

| Capability | Required runtime information or action |
| --- | --- |
| Server inventory/status | Loaded servers, connection/authentication state, errors, sources and tool inventory. |
| Connection management | Login, logout and reconnect against the owning connection, with an observable result. |
| Enable/exposure management | Change loaded policy and distinguish saved configuration from applied state. |

Pi 1.0 exposes registration declarations and some native management commands, not the complete
structured state/action surface above. Separate CLI connections cannot report the addressed worker.
Use public interfaces or supported explicit adapters; do not patch Pi/private SDK state, require
unreleased APIs or create a second MCP execution stack.

## Checks

Check source-preserving configuration edits, save/apply feedback, current-worker state and ownership,
native authentication/reconnect, extension-registered entries, keyboard/touch operation and bounded
large tool inventories. Use isolated native configuration and local fixtures rather than personal
credentials or external accounts.

## Sources

The user approved the compact design on 2026-10-05 and clarified that missing Pi capabilities remain
deferred rather than prompting Pi modifications. Associated code paths are planned; interface
evidence is recorded in [[follow-codemode-mcp-adaptation-2026-10-05]]; remaining implementation and
interface work belongs to [[follow-pi-native-capability-review-2026-10-02]].
Related contracts: [[pi-integration]], [[interface-preferences]], [[tool-presentations]].
