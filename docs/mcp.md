# MCP configuration

Open **Settings → MCP** to add, edit or remove Pi's native MCP file configuration on the connected
Host. These are saved configuration entries, not a display of the current session's connections.
Configure a server here when you want Pi to use that server's external tools; MCP is not required
for an ordinary Pi session. The server's installation and connection instructions supply the URL
or executable you will enter below.

## Choose the configuration source

- **User** edits `mcp.json` in Pi's agent directory, normally `~/.pi/agent/mcp.json`.
- **This project** edits `.pi/mcp.json` in the selected session's working directory, or the
  selected directory on the start surface.

User configuration stays available without a selected project or when the selected project's
directory is unavailable. Project-file errors do not block user-file edits; project edits require an
existing project directory and do not recreate missing directories.

Each group shows the configuration file's path. A full project definition replaces the same-name
user definition. Policy-only project entries inherit the user connection
and override enabled state, exposure or per-tool rules. Their editor offers **Inherit from user**
for enabled/exposure and keeps connection settings and credentials in the user file.

To customize an existing user server for the current project, choose **Customize for this project**
on its User row. The name and project are fixed; settings start at **Inherit from user**. Choose only
the policy you want to override, such as **Enabled in this project → Disabled**, then save. Inspire
writes just that policy, not a second copy of the connection or credentials. Edit the resulting
Project row to change the policy; remove that row to restore user inheritance. The shortcut is shown
only when the project file is editable and has no same-name entry yet.

Saving does not grant project trust; use Pi's native trust workflow. Keep personal servers and
credentials in the user file.

## Add or edit a server

Choose **Add server**, enter its name and select **User · all projects** or **This project** as the
destination. To change an existing entry, open its editor in the corresponding group.

Choose **HTTP** for a streamable HTTP endpoint, or **Stdio** for an executable and separate argument
rows. The program is one executable, not a shell command. Each argument row is one argument,
including any spaces. The HTTP endpoint must be reachable from the Host; a Stdio program and its
working directory must exist on the Host, not on the browser device. Legacy SSE is not supported.

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

The OAuth **Client registration** field shows the saved method. Use **Client ID or dynamic
registration** for a supplied client ID or dynamic registration, or **Pi metadata document (CIMD)**
when the server requires Pi's published client metadata. CIMD cannot be combined with a client ID
or client name; switching to it requires explicitly removing any stored values in those fields.
A custom CIMD callback must use `http://localhost` or `http://127.0.0.1` with the path `/callback`.
Invalid combinations are rejected without changing the file.

Saved URLs and arguments are hidden by default. In an existing server's editor, choose
**Show saved URL** or **Show saved arguments** to load them from the Host. They may contain secrets;
use this action only when you want those values displayed in this browser. You can then edit the
URL or individual argument rows without re-entering the other arguments. Merely showing values
does not change the file.

Environment/header values and OAuth values other than the registration method remain protected.
Leave a hidden input blank to keep its value, type a replacement or use its explicit removal
control. Other fields and native metadata that you do not edit remain intact.

If a file changes elsewhere, your draft stays open. **Refresh MCP files** in the editor reads the
latest revision while retaining the draft; review it, then explicitly save again. Invalid files
must be repaired before they can be edited. Project configuration symlinks pointing outside the
project are not editable here.

## Save, then apply deliberately

**Save configuration** writes the selected file only. It does not connect, sign in, disconnect or
replace a running worker. New Pi workers read the saved configuration.

After saving in an Inspire-owned session, **Reload selected session…** offers a confirmed restart
of that idle worker. Other sessions stay unchanged. For a connected native Pi, Settings instead asks
you to run `/reload` in its original terminal; restarting the Host does not reload that Pi.
Removing an entry likewise changes only the file, leaving running connections and Pi's separate
saved OAuth credentials alone.

Use the session's native `/mcp` command for status, or `/mcp login <server>`,
`/mcp logout <server>` and `/mcp reconnect <server>` through the normal command surface. These
operate through Pi; this Settings category does not infer connection health or login success from
disk configuration. A shell `pi mcp list` creates independent connections, not an inspection of
the selected worker.

If an extension replaces native MCP, its commands and configuration may differ. This editor still
targets native Pi files and does not configure the replacement.

See [Pi commands](pi-commands.md) for command preparation and Reload behavior.
