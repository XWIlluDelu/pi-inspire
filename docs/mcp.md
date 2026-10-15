# MCP configuration

Open **Settings → MCP** to add, edit or remove Pi's native MCP file configuration on the connected
Host. These are saved configuration entries, not a display of the current session's connections.

## Choose the configuration source

- **User** edits `mcp.json` in Pi's agent directory, normally `~/.pi/agent/mcp.json`.
- **This project** edits `.pi/mcp.json` in the selected session's working directory, or the
  selected directory on the start surface.

Each group shows the configuration file's path. A full project definition replaces the same-name
user definition. Pi 1.1 also supports policy-only project entries, which inherit the user connection
and override enabled state, exposure or per-tool rules. Their editor offers **Inherit from user**
for enabled/exposure and keeps connection settings and credentials in the user file.

Saving does not grant project trust; use Pi's native trust workflow. Keep personal servers and
credentials in the user file.

## Add or edit a server

Choose **HTTP** for a streamable HTTP endpoint, or **Stdio** for an executable and separate argument
rows. The program is one executable, not a shell command. Each argument row is one argument,
including any spaces. Legacy SSE is not supported.

**Advanced configuration** contains description, per-request timeout in seconds, file-enabled state,
tool exposure, and transport-specific options:

- Stdio: working directory and environment variables.
- HTTP: headers and optional OAuth client configuration. Most OAuth servers use Pi's automatic
  discovery and need no client settings.
- Per-tool exposure: exact names or `*` patterns. Exact matches win; patterns match in listed order.
  The server setting is the default for other tools.

Environment/header values and OAuth client secrets can use Pi's `${NAME}` references or its
`!command` syntax. Inspire stores these literally; it does not execute or resolve them when opening
Settings. Pi may resolve them when loading/connecting the server.

Stored URLs, arguments, environment/header values and OAuth values are not sent to the browser.
Leave a protected input blank to keep its value. Type a replacement or use the explicit removal
control. **Replace arguments** replaces the complete stored list. Other fields and native metadata
that you do not edit remain intact.

If a file changes elsewhere, your draft stays open. **Refresh MCP files** in the editor reads the
latest revision while retaining the draft; review it, then explicitly save again. Invalid files
must be repaired before they can be edited. Project configuration symlinks pointing outside the
project are not editable here.

## Save, then apply deliberately

**Save configuration** writes the selected file only. It does not connect, sign in, disconnect or
replace a running worker. New Pi workers read the saved configuration.

After saving, **Reload selected session…** offers Inspire's existing explicit Reload. It restarts
only the selected idle worker; other sessions stay unchanged. Check the Reload result in the
conversation. Removing an entry similarly leaves running connections and Pi's separate saved OAuth
credentials alone.

Use the session's native `/mcp` command for status, or `/mcp login <server>`,
`/mcp logout <server>` and `/mcp reconnect <server>` through the normal command surface. These
operate through Pi; this Settings category does not infer connection health or login success from
disk configuration. A shell `pi mcp list` creates independent connections, not an inspection of
the selected worker.

If an extension replaces native MCP, its commands and configuration may differ. This editor still
targets native Pi files and does not configure the replacement.

See [Pi commands](pi-commands.md) for command preparation and Reload behavior.
