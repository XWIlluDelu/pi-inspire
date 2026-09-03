---
scope:
  - docdoki/northstar.md
  - docdoki/spec_abstract.md
  - docdoki/specs/{workbench,pi-integration,connection-modules,terminal}.md
  - package.json
  - package-lock.json
  - inspire
  - inspire.mjs
  - deploy/systemd/**
  - server/app.ts
  - server/index.ts
  - server/terminal-*.ts
  - shared/contracts.ts
  - shared/terminal-*.ts
  - src/api.ts
  - src/app-state.ts
  - src/store.ts
  - src/terminal-*.ts
  - src/components/{AppTopbar,CommandPalette,ContextPane,TerminalPane}.tsx
  - src/styles.css
  - src/styles/*.css
  - vite.config.ts
  - scripts/{build-release,verify-release-package}.mjs
  - tests/{server,shared,web,browser}/**/*terminal*
  - tests/browser/workbench.spec.ts
---

# Remote project terminals

## Objective

Add a full remote-capable terminal surface to the contextual workbench: each project owns an ordered set of real PTY terminals shown as tabs, without terminal splitting, and any paired browser can attach through direct loopback or the existing SSH reverse ingress.

## Current state

- **Completed:** Project-scoped, ordered terminal tabs now use real PTYs owned by an installation-scoped private daemon. Browser, panel, tunnel, and ordinary Host interruptions detach views without ending the process, while explicit close owns process-tree termination.
- **Completed:** Authenticated HTTP controls and the dedicated `/terminal` WebSocket enforce same-origin paired-cookie access, one-use attach tickets, bounded frames and buffers, exact replay continuity, and one-writer ownership with explicit takeover.
- **Completed:** The lazy xterm workbench includes profiles, renaming and ordering, search, protected paste, Unicode and alternate-screen support, touch keys, focus/window modes, settings, shell integration, project-file links, Composer handoff, notifications, and Git refresh without granting Pi implicit terminal authority.
- **Completed:** Private daemon state restores tab metadata as exited after machine restart; raw output history is bounded and opt-in. Source, packaged, direct-launch, and systemd paths include the daemon and its runtime dependencies.
- **Verified locally:** `npm run check` passes formatting, lint, types, unused-code checks, production build, 1,073 unit tests, 11 portable tests, and 6 launcher tests (with the platform-appropriate skips). All 13 Chromium workbench scenarios pass, including real multi-tab PTYs, Unicode paste, alternate-screen refresh, multi-view takeover, and focused-window continuity. `npm run release:verify` validates the packed production CLI and a real packaged PTY. An isolated external-daemon lifecycle probe confirmed that a real PTY continues producing output with no Host client and delta-replays it to a replacement client under the same terminal ID.

## Next actions

- [x] Establish the terminal contracts and private daemon/runner lifecycle, including restart-safe discovery, bounded output state, exact reconnect, exclusive input ownership, resize ordering, and process-tree cleanup.
- [x] Add authenticated HTTP control routes and a dedicated terminal WebSocket data plane that work unchanged through direct loopback and `ssh-reverse`.
- [x] Build the lazy-loaded xterm surface with project tabs, profiles, search/copy/paste, keyboard and touch controls, focus mode, reconnect, takeover, and terminal-aware file links.
- [x] Persist project tab metadata and optional private output history without making browser storage or Pi session JSONL authoritative.
- [x] Integrate terminal status, notifications, command palette actions, shell integration, Git refresh, and explicit transcript handoff actions without granting Pi implicit control of a human terminal.
- [x] Validate real PTYs, Host interruption, multi-client ownership, flood/backpressure, full-screen applications, Unicode input, responsive behavior, and release packaging locally. macOS and Windows CI remain the independent platform witnesses after push.
- [x] Reconcile the product documents with the implemented contract and archive this completed stage.

## Decisions

- Terminals are grouped by normalized absolute project working directory rather than by Pi session. Changing directory inside a shell does not change that organizational identity.
- The UI uses a terminal mode plus an ordered horizontal tab strip. Multiple terminals are required; terminal splitting is excluded.
- A private terminal daemon owns PTYs independently of the browser and ordinary Inspire Host lifecycle. Host HTTP/WebSocket handling is an authenticated gateway, not terminal authority.
- Live transport uses raw terminal bytes; monotonic epochs, offsets, input sequence acknowledgements, resize revisions, bounded replay, and a canonical headless terminal state provide exact reconnect or a full-state fallback.
- Multiple paired browsers may observe one terminal, but one attachment owns input and PTY dimensions at a time. Takeover is explicit, and reconnect cannot silently steal newer ownership.
- Hiding the pane and losing a browser or tunnel detach only. Explicit terminal close owns process termination. Machine reboot may restore metadata and retained history but never pretends that a dead process survived or silently reruns commands.
- Existing browser pairing, secure same-origin cookies, exact Host/Origin validation, and short-lived attach grants protect the remote shell. Terminal identifiers are never credentials; input and output are omitted from diagnostic logs.
- `tmux` and terminal image protocols may remain optional profiles/extensions, but neither is the terminal foundation. Pi receives no implicit terminal-control capability.

## Handoff

The implementation and local acceptance are complete. Remote macOS and Windows CI remain the final independent platform witnesses after push. Final acceptance used isolated ports, sockets, state, processes, and browser-test hosts rather than restarting the user's live INSΠRE service.
