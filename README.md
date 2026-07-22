# insπre

A Linux-first local web interface for [Pi Coding Agent](https://github.com/earendil-works/pi). insπre keeps Pi as the runtime and session authority while adding a scientific-workbench interface, streaming Markdown and mathematics, session navigation, tool/thinking cards, and file-aware input.

## Run locally

Requirements: Node.js 22.19 or newer and an existing Pi configuration under `~/.pi/agent/`.

```bash
npm install
npm run build
npm start
```

Open the loopback URL printed by the host. It includes a one-time launch token; the browser removes that token from the visible URL and keeps it only for the current browser tab.

## Development

```bash
npm run dev
```

Open the Vite URL (normally `http://localhost:5173`). Development uses a fixed loopback-only token; production generates a fresh token on every launch.

## Checks

```bash
npm run check
npm run build
```

The first release is local-only. Provider credentials and unrestricted filesystem access remain in the trusted host process and are never sent to browser storage.
