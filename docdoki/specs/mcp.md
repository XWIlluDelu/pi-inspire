---
purpose: Present supported Pi MCP file configuration in compact Settings, preserving native ownership and deferring unavailable current-worker management interfaces.
progress: in-progress
covers:
  - server/mcp*.ts
  - server/configuration-edit-locks.ts
  - shared/*mcp*.ts
  - src/components/*Mcp*.tsx
  - src/styles/mcp-settings.css
  - tests/server/*mcp*.ts
  - tests/server/configuration-edit-locks.test.ts
  - tests/web/*mcp*.tsx
  - tests/browser/*mcp*.ts
---

# MCP management

## Goal

Settings provides compact MCP configuration. Pi owns connections, credentials, tool policy and
execution. Configuration files are editable now; the complete current-worker management panel
remains decided but deferred until public runtime interfaces can support it.

- Add starts with name, target and HTTP URL or stdio program/arguments. Edit shows the fixed
  identity/scope/transport as text rather than disabled controls and leads with the editable URL or
  program. Environment, headers, timeout, exposure and OAuth client settings are advanced controls.
- Preserve unedited fields. Never return stored or resolved authentication secrets to the browser
  or execute value-resolution hooks to display configuration.
- Distinguish file source and precedence from the addressed worker's loaded state. Extension
  registrations retain their native source and mutation semantics.
- Saving and applying are distinct. Offer existing explicit Reload when needed, without permanent
  extra status on each row or silent worker replacement.
- No tool-execution console, MCP Apps renderer or generic compatibility framework is included.
  Replacement MCP implementations require explicit adaptation, not assumed native controls.

## File configuration

Settings → MCP groups file entries under **User** and **Project**, with quiet source-path captions.
Rows show name, transport, file-disabled state and an understated same-name project override, not
connection health. Add, focused Edit and confirmed Remove use the established Settings controls,
with Save/Cancel reachable while the form body scrolls. Project trust is explained briefly in the
project editor, not repeated as a policy/status block in each group.

The Host derives the user file from public `getAgentDir()/mcp.json`. The project file is
`<cwd>/.pi/mcp.json`; an addressed session's Host-resolved directory wins over a supplied directory.
The start surface uses its selected directory. Clients cannot supply arbitrary configuration paths.
Full project definitions replace same-name user definitions. Pi 1.1 policy-only project entries
inherit the user connection and override `enabled`, `exposure`, and `toolExposure`; their editor
preserves that shape. Absent enabled/exposure fields display **Inherit from user**, and choosing it
removes the corresponding project field. Pi applies project configuration only when the project is
trusted. Reading or saving a project file grants no trust and loads no project code.

The form supports stdio command, argument rows, working directory and environment; streamable HTTP
URL, headers and OAuth client fields; description, request timeout in seconds, file-enabled state,
server exposure and ordered exact/pattern tool exposure. OAuth discovery remains Pi's default.
Unknown fields, top-level settings, other entries and unedited nested values remain intact.
Transport and identity of an existing entry stay fixed; remove/add replaces them deliberately.
While adding a server, switching transport retains its visible header/environment draft; submission
uses the selected transport's displayed edits, never an invisible discarded value.

Stored URLs, argument contents, environment/header values and OAuth values stay on the Host.
The browser receives presence/keys/counts, never secret values or masked replacements that could
overwrite them. Blank protected inputs retain stored values; removal is explicit. Replacing
arguments replaces the entire list. Exposure rule editing replaces that ordered map in displayed
order, including removed/re-added patterns; other edits leave it untouched. Configuration removal
does not delete Pi's separate OAuth credential store.

Writes validate the edited native fields, use revision-checked locks and atomic restrictive-mode
replacement, and preserve legitimate user-file symlinks. Regular files lock their native resolved
target once, including case/normalization aliases. Final symlinks retain both lexical and target
authorities; publishing rechecks the target and revision. Project symlinks cannot escape their project.
Added names are checked across user/project files for Pi's hyphen/underscore namespace collisions;
exact same-name overrides remain legal. Invalid files and conflicting edits are reported rather
than overwritten. A conflict keeps the form
draft; Refresh reads the new revision without clearing edits, and another explicit Save merges only
the edited subset. Drafts survive category changes but are withdrawn on session/directory/Host
ownership changes; stale asynchronous results cannot populate the new owner.

A successful write reports saved-to-file, not applied. The optional, confirmed **Reload selected
session** uses Inspire's existing idle-worker Reload path. Other workers are unchanged; new workers
read the saved configuration. Save failure retains the draft. A successful save followed by a read
failure still reports the successful commit and asks for Refresh.

User guide: [MCP configuration](../../docs/mcp.md).

## Current-worker interface boundary

Pi 1.0/1.1 public registration APIs describe declarations, not a complete loaded-runtime inventory.
`getMcpServers` omits the full file-server connection/tool state. Taking over
`mcp_servers_change` would implement connections rather than observe them.

| Decided GUI capability | Available interface and precise remaining block |
| --- | --- |
| Loaded server/status rows, source details and attributable errors | RPC `/mcp` emits native status text. No complete structured current-worker inventory exposes loaded file and extension entries, source, auth state and errors together. Do not parse presentation text into invented state. |
| Searchable, bounded tool inventory for a server | Public generic tool information is not the complete server inventory, including disabled, disconnected and overridden entries. A native attributable inventory is still required. |
| Login/logout/reconnect on the owning connection | Public `/mcp login <server>`, `logout` and `reconnect` commands remain usable through the session's existing command surface and native UI notifications. Dedicated row actions still need the loaded owning entry and attributable outcome; a generic handled-command receipt is not success. No independent CLI login is labeled current-worker management. |
| Immediate enable/exposure controls | Native TUI offers these actions; documented RPC subcommands do not. File-enabled/exposure editing is implemented as saved policy only, with explicit Reload. A supported loaded-policy setter/result remains missing. |
| Connection-error navigation | Requires an attributable server/owner error; navigation must not imply repair. |
| Extension-registered servers | Native declarations retain source and in-memory mutation ownership. They are not projected as editable disk entries. |

Changing a file to disable a server leaves its existing RPC connection loaded; native reconnect
still targets that entry. A separate `pi mcp list --json` reads the changed file instead.
The unsupported `/mcp disable <server>` can return a handled receipt with usage guidance.
Current-worker controls therefore need attributable runtime state and action results.

Configured MCP tools and Codemode composition continue through Pi.

## Checks

- `tests/server/mcp-config.test.ts`: secret-safe projections, unexecuted hooks, source-preserving
  edits, policy-only inheritance, namespace collisions, invalid files, conflicts and path authority.
- `tests/server/mcp-native.integration.test.ts`: native file consumption, trusted precedence,
  Pi 1.1 policy inheritance without credential duplication, and file/loaded-worker separation.
- `tests/web/mcp-settings.test.tsx`: stale-owner withdrawal, HTTP add, duplicate keys, displayed
  rule order and policy-only controls.
- `tests/browser/mcp-settings.spec.ts`: desktop and narrow Chromium with isolated real file
  service, scoped edits, protected values, draft/category continuity, conflict refresh, explicit
  Reload, stdio arguments, removal and narrow policy editing.
Use isolated configuration and local fixtures, not personal credentials or external accounts.

## Related interfaces

Remaining requirements: [[pi-capability-gaps]]. Native references: installed Pi `docs/mcp.md`,
`docs/cli.md`, `docs/rpc.md`, `docs/extensions.md` and public SDK declarations.
Related contracts: [[pi-integration]], [[interface-preferences]], [[tool-presentations]].
