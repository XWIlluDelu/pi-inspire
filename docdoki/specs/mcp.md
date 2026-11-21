---
purpose: Present supported Pi MCP file configuration in compact Settings, preserving native ownership and deferring unavailable current-worker management interfaces.
progress: in-progress
covers:
  - server/mcp*.ts
  - server/configuration-file.ts
  - shared/*mcp*.ts
  - src/components/*Mcp*.tsx
  - src/components/ConfigurationForm.tsx
  - src/use-configuration-document.ts
  - src/styles/mcp-settings.css
  - tests/server/*mcp*.ts
  - tests/server/configuration-file.test.ts
  - tests/web/configuration-document.test.tsx
  - tests/browser/*mcp*.ts
area: "Input & Models"
---

# MCP management

## File configuration

Settings → MCP edits native Pi files on the connected Host. Pi owns trust, credentials,
connections, tool exposure and execution. Replacement MCP implementations need their own
adaptation. Tool execution and MCP Apps rendering are outside this panel's scope.

| Source | Authority and precedence |
| --- | --- |
| User | `getAgentDir()/mcp.json`. Remains editable without a project, including when the project file is unavailable or invalid. |
| Project | `<cwd>/.pi/mcp.json`. An addressed session supplies its Host-resolved cwd, otherwise New supplies the selected directory. A closed session is rejected. Project writes require an existing directory and contain symlink targets within it. |
| Full project entry | Replaces the same-name user definition. Pi loads it according to project trust. Reading and editing run no project code and grant no trust. |
| Project policy | Inherits the same-name user server. Only `enabled`, `exposure` and `toolExposure` can change. The Host validates the merged definition without copying credentials into the project. |

Show the path, errors and rows for each available file. Rows identify the server, transport,
file-disabled state and same-name override. With no project, show user configuration and a
project-selection hint. Offer **Customize for this project** on user rows when the project file is
editable and has no same-name entry. Its form starts with inherited defaults and enables Save
after a policy edit. **Inherit from user** removes the field. Removing the override restores
inheritance.

### Editing and protected values

Add sits beside the section title and starts with name, target and transport. Edit fixes the
identity, target and transport. New focuses Server name, existing definitions focus URL or
Program, and policy overrides focus Tool exposure with its menu closed. Save, Cancel and the
focused field's label remain visible as the form scrolls. Project forms explain trust.

- Stdio accepts one executable and argument rows. Streamable HTTP accepts a URL. Advanced controls
  cover environment or headers, working directory, OAuth, description, timeout in seconds, enabled
  state and ordered exposure rules. Switching transport while adding retains each draft and submits
  only the selected fields.
- Shared field descriptors define patches, controls and safe public values. Lists expose connection
  presence, key names and counts. **Show saved URL** or **Show saved arguments** reads only the
  active transport's field for the reviewed entry. This authenticated, non-cacheable read leaves
  hooks unevaluated. An owner or revision change retires the reveal. Refresh retains explicit edits.
- Blank protected fields keep their stored values. Replacement and removal are explicit. Edits to
  revealed arguments replace the array. Editing exposure rules replaces their map in displayed
  order, including removed and re-added patterns. Reverting a draft preserves the original field.
  Other entries, unknown fields and unedited nested values survive publication.
- OAuth defaults to Auto. An untouched registration field retains its absence. Display Auto, DCR
  and CIMD and allow Pi's native client ID, name, metadata URL and callback fields. The form uses
  the presence of stored identity fields to flag CIMD conflicts and requires explicit removal.
  The Host validates the complete merged OAuth object, including port consistency and CIMD's
  loopback HTTP `/callback` restriction.

### Publication and application

Use the native-file transaction and draft ownership defined in [[model-settings]]. Cross-file
additions serialize the check for Pi's hyphen/underscore name collisions. Exact same-name project
overrides remain legal. A conflict keeps the draft open. Refresh reviews the new revision and an
explicit Save merges the edited fields. Removing a server leaves Pi's separate OAuth store intact.

New workers read saved configuration. For an Inspire-owned idle worker, **Reload selected
session…** requires confirmation and reports the result here. A taken-over terminal Pi uses
`/reload` in its original terminal. See the [user guide](../../docs/mcp.md).

## Current-worker management

The following controls remain decided and await a supported public interface. Pi's
`getMcpServers` reports registrations and `mcp_servers_change` delegates connections to its
handler. Neither observes the complete state of the owning worker.

| Capability | Required evidence |
| --- | --- |
| Status, source and error navigation | Structured, attributable file and extension server state, including auth and connection errors. |
| Searchable, bounded tool inventory | Tools for the addressed server, including disabled, disconnected and overridden entries. |
| Login, logout and reconnect | Loaded server identity and attributable outcome. The native `/mcp` commands remain available. |
| Immediate enable and exposure controls | A supported setter and result on the loaded worker. File policy applies on a fresh load. |
| Extension entries | Their native source and in-memory mutation owner. Disk edits apply to file entries. |

A running RPC connection can stay loaded after its file entry is disabled. Shell `pi mcp list`
starts independent connections, and a handled RPC command can return usage guidance. These
responses cannot establish a row's runtime state. See [[pi-capability-gaps]], [[pi-integration]],
[[interface-preferences]] and [[tool-presentations]].
