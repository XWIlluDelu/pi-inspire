# MCP configuration

Open **Settings → MCP** to configure the external tools Pi can use. Use the server's installation
instructions to find its URL or executable. The server must be reachable from the connected Host.

## Choose a configuration file

| Target | File and scope |
| --- | --- |
| **User · all projects** | `mcp.json` in Pi's agent directory, normally `~/.pi/agent/mcp.json`. Available even when no project is open. |
| **This project** | `.pi/mcp.json` in the selected session or New directory. Requires an existing directory. Pi applies project settings according to its trust decision. |

A full project entry replaces the user server of the same name. To change only enabled state or
tool exposure, choose **Customize for this project** on the user entry. Select an override, such
as **Enabled in this project → Disabled**, then save. Removing this project entry restores the user
policy. Its connection details and credentials stay in the user file.

## Add or edit a server

Choose **Add server**, name it and select the target file and transport. Use **HTTP** for a
streamable HTTP endpoint, or **Stdio** for one executable and one argument per row. Argument rows
preserve spaces. The executable and working directory must exist on the Host. To change the name
or transport of a saved server, remove the entry and add its replacement.

**Advanced configuration** includes description, timeout in seconds, enabled state and tool
exposure. Exact tool names take precedence over `*` patterns, which match in listed order. The
server's exposure applies to remaining tools.

Stdio entries also offer a working directory and environment variables. HTTP entries offer headers
and OAuth settings. Environment values, headers and OAuth client secrets accept Pi's
`${NAME}` references and `!command` hooks. Settings keeps them literal. Pi can resolve them when
connecting.

Most HTTP servers use Pi's automatic OAuth discovery. Leave **Client registration** at its default
unless the server specifies a method. Auto uses a supplied client ID, otherwise Pi tries its
metadata document on compatible servers. A client name or nonstandard callback selects dynamic
registration. **Client ID or dynamic registration** uses the supplied ID or
registers a client. **Pi metadata document (CIMD)** requires a compatible server and explicit
removal of any saved client ID or name. A custom CIMD callback uses HTTP on `localhost` or
`127.0.0.1` with the path `/callback`.

Saved URLs and arguments may contain secrets. Choose **Show saved URL** or **Show saved arguments**
to display them in this browser and edit individual values. Header, environment and OAuth secrets
remain hidden. Leave their fields blank to keep them, enter replacements or explicitly remove
them. Other fields stay intact.

If another editor changes the file, **Refresh MCP files** keeps your draft and reads the current
revision. Review the result and save again. Repair malformed files before editing. Project
configuration symlinks must stay within the project.

## Apply a saved change

New workers read the saved file. For an idle Inspire-owned session, Inspire reloads it automatically
after saving. While a session is busy, use **Reload selected session** once it becomes idle. A
taken-over Pi uses `/reload` in its original terminal. Removing a configuration entry leaves Pi's
saved OAuth credentials intact.

Use the selected session's `/mcp` command to inspect live connections. `/mcp login <server>`,
`/mcp logout <server>` and `/mcp reconnect <server>` act on that session. Shell `pi mcp list` opens
independent connections. Extensions that replace native MCP may supply their own commands and
configuration. See [Pi commands](pi-commands.md).
