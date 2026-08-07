# insπre

A Linux-first local web workbench for [Pi Coding Agent](https://github.com/earendil-works/pi). The name is both *inspire* and *inspect Pi rendering*: insπre keeps Pi as the runtime and session authority while making its conversations, activity, and files easier to inspect — streaming Markdown and mathematics, session navigation, tool and thinking cards, and file-aware input, in a scientific-workbench interface.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/conversation-dark.png">
  <img src="docs/screenshots/conversation-light.png" alt="insπre conversation view with streaming Markdown, KaTeX mathematics, tables, code, and tool activity cards">
</picture>

## What you get

- **Pi underneath, unchanged.** Sessions are real Pi sessions running under Pi's own runtime. insπre creates no parallel conversation database: refresh or reconnect and the visible state is rebuilt from Pi's session records.
- **Rich defensive rendering.** One Markdown pipeline covers both streaming and settled text — headings, tables, task lists, links, syntax-highlighted code, and KaTeX inline and display mathematics — rendered defensively, so untrusted model output cannot inject markup or fire network requests.
- **Session navigation that respects running work.** Find, open, continue, rename, and switch sessions; pin the important ones to a persistent top section; collapse project folders; hide sessions into a reversible Hidden group. Multiple sessions run concurrently under independent Pi runtimes, and navigating away never stops background work — the navigation distinguishes running, unseen success, and unseen error.
- **A complete composer.** Text, searchable project-file references, pasted or dropped images, and ordinary file attachments, plus steering messages and follow-ups while a run is active. Model and thinking-level pickers use your existing Pi configuration.
- **Adaptive activity cards.** Thinking and tool activity render as distinguishable, inspectable cards with file links and status. The default Dynamic mode keeps the current work expanded, collapses each completed tool, and compacts a completed tool batch at the next model call; fixed expanded, collapsed, Compact, and hidden choices remain available independently.
- **Session-bound file previews.** Files referenced by Pi messages or tool activity open beside the conversation as defensive previews — images, HTML, PDF, and text/code — without granting the browser arbitrary filesystem access.
- **A workbench, not a chat page.** Collapsible navigation, a contextual resources panel, a command palette with keyboard accelerators, and a coherent light-and-dark design system (Noto Sans SC, IBM Plex Serif for the wordmark, IBM Plex Mono for code and data).

<table>
  <tr>
    <td><img src="docs/screenshots/welcome-dark.png" alt="Welcome screen for starting a new session in a chosen project directory"></td>
    <td><img src="docs/screenshots/command-palette-dark.png" alt="Command palette with actions, preferences, and keyboard shortcuts"></td>
    <td><img src="docs/screenshots/settings-light.png" alt="Settings dialog with theme, card visibility, and launch behavior"></td>
  </tr>
  <tr>
    <td align="center"><em>Welcome screen — start work in any project directory</em></td>
    <td align="center"><em>Command palette — every action a keystroke away</em></td>
    <td align="center"><em>Settings — theme, card defaults, launch behavior</em></td>
  </tr>
</table>

## Run locally

Requirements: Node.js 22.19 or newer and an existing Pi configuration under `~/.pi/agent/`.

Simplest:

```bash
./inspire
```

That installs dependencies if needed, builds the client when missing, starts the loopback host, and opens the browser with the one-time launch token. Running it again is idempotent: a healthy instance from the same checkout is reused and reopened rather than replaced. Lifecycle commands and other modes:

```bash
./inspire status   # show the managed local instance and URL
./inspire restart  # gracefully replace that verified instance
./inspire stop     # gracefully stop that verified instance
./inspire mock     # UI-only mock runtime (the screenshots above)
./inspire dev      # Vite + host with hot reload
./inspire build    # client build only
```

The launcher never kills an arbitrary process merely because it owns the configured port. Reuse requires the private state plus an authenticated constant-size health response. An unrelated or legacy occupant is reported with an inspection command; `stop`/`restart` may signal only the exact private-state process whose PID owner, process-start identity, working directory, and command line identify it as this checkout, including when that exact process is too unhealthy to answer the health probe.

Equivalent npm entry points remain available (`npm start`, `npm run start:mock`, `npm run dev`). The browser removes the token from the visible URL and keeps it only for the current browser tab.

## Development

```bash
./inspire dev
```

Or `npm run dev`. Development uses a fixed loopback-only token; production generates a fresh token on every launch.

## Checks

```bash
npm run check
npm run build
```

## Privacy

The first release is local-only. The loopback host is the only privileged boundary: provider credentials and unrestricted filesystem access stay in the trusted host process and are never sent to browser storage.
