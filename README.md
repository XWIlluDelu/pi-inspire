# insπre

A Linux-first local web interface for [Pi Coding Agent](https://github.com/earendil-works/pi). insπre keeps Pi as the runtime and session authority while adding a scientific-workbench interface, streaming Markdown and mathematics, session navigation, tool/thinking cards, and file-aware input.

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
./inspire mock     # UI-only mock runtime
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

The first release is local-only. Provider credentials and unrestricted filesystem access remain in the trusted host process and are never sent to browser storage.
