# INSΠRE

Inspire is a local graphical workbench for [Pi Coding Agent](https://github.com/earendil-works/pi): conversations, tool activity, files, and terminals in one interface. It uses your installed Pi, existing configuration, and native session records.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/conversation-dark.png">
  <img src="docs/screenshots/conversation-light.png" alt="Conversation with streaming Markdown, mathematics, code, and tool activity">
</picture>

## Features

- **Technical conversations:** streaming Markdown, syntax-highlighted code, tables, and inline/display mathematics, with search and a prompt outline.
- **Concurrent sessions:** search retained conversation text, inspect History, continue branches, and Fork/Clone independent sessions. Switching keeps background work running; navigation shows running work and unseen results.
- **Rich input:** project-file references, images/files, retained drafts and prompt history, plus Steer/Queue with text/image recovery during a run.
- **Native Pi controls:** model/thinking selection, saved defaults/common models, provider configuration/login, direct shell input, compaction, and HTML/JSONL export.
- **Inspectable activity:** live tool output, native and customizable tool cards, and independent Thinking/tool detail settings. Adaptive mode shows current work and compacts completed activity.
- **Files and Changes:** browse the workspace, inspect Git diffs, and preview images, Markdown, notebooks, HTML, PDF, source, audio, and video beside the conversation.
- **Persistent terminals:** project-scoped shell tabs survive browser disconnects and Host-only restarts.
- **Desktop and narrow layouts:** resizable panes, a command palette, keyboard shortcuts, and Wisteria, Hydrangea, Lycoris, Chimonanthus, and classic Jade/Amber palettes, each in light and dark.

<table>
  <tr>
    <td><img src="docs/screenshots/welcome-dark.png" alt="Welcome screen"></td>
    <td><img src="docs/screenshots/command-palette-dark.png" alt="Command palette"></td>
    <td><img src="docs/screenshots/settings-light.png" alt="Settings"></td>
  </tr>
  <tr>
    <td align="center"><em>New session</em></td>
    <td align="center"><em>Command palette</em></td>
    <td align="center"><em>Settings</em></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/conversation-hydrangea-light.png" alt="Light conversation"></td>
    <td><img src="docs/screenshots/resources-dark.png" alt="Files and resource preview"></td>
    <td><img src="docs/screenshots/mobile-chimonanthus-light.png" alt="390px workbench"></td>
  </tr>
  <tr>
    <td align="center"><em>Hydrangea palette</em></td>
    <td align="center"><em>Resources</em></td>
    <td align="center"><em>Narrow layout</em></td>
  </tr>
</table>

## Run locally

Requirements: **Node.js 22.19+** and a separately installed **Pi** available as `pi` on `PATH`.
Windows Hosts also require **PowerShell 7** (`pwsh`), available on `PATH` or in its standard
Program Files installation. Internal Windows operations use this current runtime, not the legacy
inbox Windows PowerShell engine.

On Windows PowerShell with script execution disabled, use `npm.cmd`, `inspire.cmd` and `pi.cmd`
in place of the bare command names below. These npm-generated batch shims work without changing
your execution policy; for example, `npm.cmd run inspire -- status`.

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

From this checkout:

```bash
npm run inspire
npm run inspire -- status
npm run inspire -- restart
npm run inspire -- stop
```

The launcher installs dependencies and builds the client when needed, starts the loopback Host, and opens the browser. Later launches reuse the matching running instance. On Linux and macOS, `./inspire` is an equivalent wrapper.

Inspire targets the latest Pi release; `package.json` records the version used by development compatibility checks. The running Host loads both the SDK and RPC worker from your external Pi installation, using its normal agent directory and project configuration.

### Platform support

| Capability | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Host, Pi sessions, launcher, project terminals | Supported | Supported | Supported |
| Page Restart Host (launcher-owned or installed service) | Supported | Supported | Supported |
| Restart all (installed Host + terminal services) | Supported | — | — |
| Chromium workbench tests in CI | Yes | Yes | Yes |
| Native session Trash | Freedesktop Trash | `~/.Trash` | Recycle Bin |
| Persistent systemd services | Yes | — | — |
| Herdr enhancement and managed reverse SSH | Yes | — | — |

### Persistent Linux service

```bash
./inspire service install-host
./inspire service enable-host
```

The usual launcher commands then manage that installation's services. Host-only restart preserves terminal tabs; `restart --all` also restarts the terminal service and ends its processes. **Settings → System → Host → Restart** provides the same scopes and asks for confirmation before interrupting Pi work.

See [Running and maintaining Inspire](docs/host.md) for service behavior, shell environments, packaging, and diagnostics, and the [0.6.0 changelog](CHANGELOG.md) for changes and upgrade notes.

## Pi commands and customization

- [Pi commands](docs/pi-commands.md): browser controls, compaction/export/reload, and terminal-only commands.
- [Extension adaptation](docs/extensions.md): supported RPC UI, session lifecycle, text-widget recipes, and source customization.
- [MCP configuration](docs/mcp.md): scoped native server forms, protected values, and explicit Reload.
- [Tool presentations](docs/tool-presentations.md): local JSON rules for custom tools and Thinking cards, including exact tool-name overrides.

Tools, prompts, models, credentials, and extensions remain configured in Pi. Tool-presentation files customize the GUI; they do not select which extensions run.

## Remote access and Herdr

[Reverse SSH](docs/ssh-reverse.md) connects a Linux Host to a user-controlled HTTPS edge. The browser and terminal use the same tunnel; Pi, session files, and project processes stay on the Host.

Optional **Settings → System → Host → Herdr enhancement** places Pi workers in Herdr panes while
retaining the same GUI. It requires Linux, Herdr, a systemd user manager, and writable cgroup v2 scopes
with `cgroup.kill`. The saved choice takes effect after a Host restart.

With it enabled, Inspire connects to sessions already running in a Herdr Pi terminal: send text and
images, read replies, select models/thinking, and stop agent generation in the same process. Install
the matching [session-activity extension](docs/extensions.md#control-the-same-herdr-pi-terminal) in
that Pi. Reload, Compact, model cycling and shell interruption remain in its terminal. Closing or
restarting Inspire leaves those external Pi sessions running.

### Access and trust

Pairing grants full control of the installation, including a shell with the Host user's permissions. Pair only trusted browser profiles and use HTTPS remotely. A remote HTTPS edge can observe application traffic, so it must also be trusted.

Provider credentials stay on the Host. Conversation Markdown is sanitized. HTML previews are static by default; **Enable interaction** runs a trusted file's scripts and loads its resources in an isolated frame, and **Stop interaction** returns to static viewing. Local file previews are authorized against the selected session and workspace.

## Development

```bash
npm run dev       # Host and Vite development servers
npm run check     # Formatting, lint, types, build, unit and launcher tests
npm run ci        # Also runs browser tests
```

`npm run inspire -- mock` opens the demonstration workspace; choose a separate `INSPIRE_PORT` if the normal Host is running. `npm run dev` (or `npm run inspire -- dev`) opens the owned Vite page only after authenticated Host readiness, using a one-use pairing link and fresh private development credentials. Occupied ports fail rather than falling through to another listener. See [development checkout](docs/host.md#development-checkout) and [browser pairing](docs/host.md#browser-pairing).

The [design overview](https://github.com/XWIlluDelu/pi-inspire/blob/main/docdoki/spec_abstract.md) links to current contracts and open work. [Host operations](docs/host.md#build-and-install-a-package) covers release packaging.

## License

[MIT](LICENSE). Release builds include third-party notices at `dist/THIRD_PARTY_NOTICES.txt`; bundled font licenses are under `src/assets/licenses/`.
