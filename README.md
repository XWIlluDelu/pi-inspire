# INSΠRE

A Linux-first local workbench for [Pi Coding Agent](https://github.com/earendil-works/pi). **INSΠRE** is the visual lockup; *Inspire* is the product name in prose, reflecting both *inspire* and *inspect Pi rendering*. Inspire keeps Pi as the runtime and session authority while making conversations, activity, and files easier to inspect — streaming Markdown and mathematics, session navigation, tool and thinking cards, and file-aware input, in a scientific-workbench interface.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/conversation-dark.png">
  <img src="docs/screenshots/conversation-light.png" alt="INSΠRE conversation view with streaming Markdown, KaTeX mathematics, tables, code, and tool activity cards">
</picture>

## What you get

- **Pi underneath, unchanged.** Sessions are real Pi sessions running under Pi's own runtime. Inspire creates no parallel conversation database: refresh or reconnect and the visible state is rebuilt from Pi's session records.
- **Rich defensive rendering.** One Markdown pipeline covers both streaming and settled text — headings, tables, task lists, links, syntax-highlighted code, and KaTeX inline and display mathematics — rendered defensively, so untrusted model output cannot inject markup or fire network requests.
- **Session navigation that respects running work.** Find, open, continue, rename, and switch sessions; pin or hide both sessions and project folders; restore hidden work from one reversible group. Multiple sessions run concurrently under independent Pi runtimes, and navigating away never stops background work — the navigation distinguishes running, unseen success, and unseen error. On narrow screens the same navigation becomes an off-canvas drawer instead of compressing the conversation.
- **A complete composer.** Text, searchable project-file references, pasted or dropped images, and ordinary file attachments, plus steering messages and follow-ups while a run is active. Model and thinking-level pickers use your existing Pi configuration.
- **Adaptive activity cards.** Thinking and tool activity render as distinguishable, inspectable cards with file links and status. The default Dynamic mode keeps the current work expanded, collapses each completed tool, and compacts a completed tool batch at the next model call; fixed expanded, collapsed, Compact, and hidden choices remain available independently.
- **Session-bound file previews.** Files referenced by Pi messages or tool activity open beside the conversation as defensive previews — images, HTML, PDF, and text/code — without granting the browser arbitrary filesystem access.
- **A workbench, not a chat page.** Collapsible navigation, a contextual resources panel, a command palette with keyboard accelerators, and a coherent light-and-dark design system (IBM Plex Sans SC for interface, reading, and the INSΠRE wordmark; Flux Mono SC for code and CJK-aligned data).

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

### Additional current surfaces

<table>
  <tr>
    <td><img src="docs/screenshots/conversation-jade-light.png" alt="INSΠRE conversation in the Jade light palette"></td>
    <td><img src="docs/screenshots/resources-dark.png" alt="INSΠRE resources panel in the Amber dark palette"></td>
    <td><img src="docs/screenshots/mobile-amber-light.png" alt="INSΠRE conversation at a 390 pixel Amber light viewport"></td>
  </tr>
  <tr>
    <td align="center"><em>Jade palette</em></td>
    <td align="center"><em>Resources</em></td>
    <td align="center"><em>390px mobile workbench</em></td>
  </tr>
</table>

## Run locally

Requirements: Node.js 22.19 or newer and a separately installed Pi available as `pi` on `PATH` (normally `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`). Inspire loads the public SDK and starts RPC workers from that same Pi package, so the terminal and web workbench use one runtime installation and the same `~/.pi/agent/` state.

Simplest:

```bash
./inspire
```

Without an installed host user service, that installs dependencies if needed, builds the client when missing, starts the loopback host, and opens the browser with the one-time launch token. Running it again is idempotent: a healthy instance from the same checkout is reused and reopened rather than replaced. Lifecycle commands and other modes:

```bash
./inspire status   # show the managed local instance and URL
./inspire restart  # gracefully replace that verified instance
./inspire stop     # gracefully stop that verified instance
./inspire mock     # UI-only mock runtime (the screenshots above)
./inspire dev      # Vite + host with hot reload
./inspire build    # client build only
```

The launcher never kills an arbitrary process merely because it owns the configured port. Reuse requires the private state plus an authenticated constant-size health response. An unrelated or legacy occupant is reported with an inspection command; `stop`/`restart` may signal only the exact private-state process whose PID owner, process-start identity, working directory, and command line identify it as this checkout, including when that exact process is too unhealthy to answer the health probe.

### Persistent host service

To make the host a persistent user service, install and enable it once:

```bash
./inspire service install-host
./inspire service enable-host
```

After that, the same `./inspire`, `./inspire status`, `./inspire restart`, and `./inspire stop` commands delegate to the matching `inspire-host.service`; no `systemctl` syntax is needed. The service is verified against the current checkout before delegation, and a checkout without that service continues to use direct-launcher mode.

Equivalent npm entry points remain available (`npm start`, `npm run start:mock`, `npm run dev`). On first use the launcher passes a one-time bearer to the browser, which exchanges it for an origin-scoped `HttpOnly`, `SameSite=Strict` cookie and removes the bearer from the URL. Later launches for the same checkout, host, and port reuse the private persisted host token; the browser never stores that bearer durably in JavaScript. Generated tokens contain 48 cryptographic random bytes, encoded as 64 base64url characters (384 bits); earlier generated token lengths rotate on the next host start.

## SSH reverse connection

The optional `ssh-reverse` connection module opens a loopback-only reverse SSH tunnel from the local host to a user-controlled HTTPS edge. It is separate from the core host lifecycle and may be started, inspected, stopped, or installed as a user service independently:

```bash
./inspire connection ssh-reverse init
./inspire connection ssh-reverse start
```

See [the SSH reverse connection guide](docs/ssh-reverse.md) for local configuration, automatic recovery, and a minimal server-side HTTPS proxy example. The module is personal shared-token access, not multi-user collaboration or device-level authorization.

## Release package

INSΠRE is packaged as a standalone npm CLI application, not as a Pi resource package: it intentionally has no `pi` manifest or `pi-package` keyword and does not bundle a second Pi runtime. Pi Coding Agent is a development dependency for type-checking and compatibility tests; an installed release resolves the user's external Pi package as its sole SDK and RPC authority.

```bash
npm run release:verify
npm pack
```

`prepack` builds the browser client and compiled Node host. The verifier requires npm's canonical `inspire` bin metadata, checks the exact tarball through `npm publish --dry-run`, installs it with production dependencies only, proves that Pi is absent from that installation, confirms that required assets are present while tests and TypeScript source are absent, exercises the generated `inspire` bin through mock `start`, `status`, authenticated health, and `stop`, then uses one separately installed Pi package for both the public SDK and a real RPC worker and creates an empty session without invoking a model.

The current release is distributed through GitHub Releases rather than the npm registry. Download, verify, and install its local tarball:

```bash
curl -fLO https://github.com/XWIlluDelu/pi-inspire/releases/download/v0.1.0/inspire-pi-gui-0.1.0.tgz
curl -fLO https://github.com/XWIlluDelu/pi-inspire/releases/download/v0.1.0/SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
npm install --global ./inspire-pi-gui-0.1.0.tgz
inspire
```

A bare `npm install --global inspire-pi-gui` is not an installation path unless a later release is explicitly published to the npm registry.

## Development

```bash
./inspire dev
```

Or `npm run dev`. Development uses a fixed loopback-only token. Production reuses a private checkout/host/port-scoped token unless `INSPIRE_TOKEN` is supplied explicitly; every browser origin must still complete the one-time cookie exchange.

## Diagnostics

The host writes metadata-only structured JSONL diagnostics to its private user-state directory (normally `~/.local/state/inspire/logs/<installation-key>.jsonl`). Projection-conflict banners include an incident ID that can be matched to these records. Logs correlate the host, slot incarnation, Pi worker/PID, RPC request, projection revision/fingerprint, persistence expectation, and ownership decision; they do not record prompts, tool output, extension payloads, credentials, or raw child stderr. Files are mode `0600`, directories are `0700`, and rotation retains five 5 MiB files by default. `INSPIRE_LOG_PATH` may select another file only inside an existing private directory.

## Checks

```bash
npm run check
npm run build
```

`npm run check` combines TypeScript's unused-symbol checks, Biome lint, architectural import boundaries, and Knip's unused entry/export/dependency analysis.

## Privacy

The default deployment is local-only. A deliberately configured personal relay keeps the loopback host as the privileged boundary: provider credentials and unrestricted filesystem access stay in the trusted host process and are never sent to browser storage or the relay's application layer.

## License

[MIT](LICENSE). The release bundle also includes generated third-party software notices at `dist/THIRD_PARTY_NOTICES.txt`; the official IBM Plex font licenses are distributed under `src/assets/licenses/`.
