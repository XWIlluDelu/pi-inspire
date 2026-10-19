# Running and maintaining Inspire

The Host runs Pi and serves the browser workbench. It binds to loopback; [reverse SSH](ssh-reverse.md) provides optional remote ingress. Requirements and the quick start are in the [README](../README.md#run-locally).

Examples below use `./inspire` in a Linux/macOS source checkout. On every supported platform, use `npm run inspire -- <arguments>`; a globally installed package exposes `inspire` directly.

## Lifecycle

| Command | Effect |
| --- | --- |
| `inspire` | Start or reopen the matching instance. |
| `inspire status` | Check the managed Host. |
| `inspire restart` | Prepare the next build/runtime, then restart the Host and its Pi workers. Preserve project terminals. |
| `inspire restart --all` | Restart this installation's Linux Host and terminal services; end terminal processes. |
| `inspire stop` | Stop the Host; also stop its installed terminal service. |

A CLI restart stops Pi workers. In **Settings → System**, restart first checks for unfinished work. A refusal offers a separately confirmed **Stop work and restart**, which interrupts Pi work and discards Pending input. An idle worker does not block this check. Preparation failure leaves the current Host running; after a disconnect, the browser observes the submitted restart instead of sending another one.

Restart scopes leave connection services running. `--all` requires matching installed Linux services; a direct-launcher restart is Host-only. The launcher authenticates managed instances and reports an unrelated port occupant for inspection rather than terminating it.

## Linux user services

```bash
./inspire service install-host
./inspire service enable-host
```

Installation writes `inspire-host.service`, `inspire-terminal.service`, and an idle-maintenance timer. The launcher delegates lifecycle commands after verifying that the units belong to this installation. Stop or disable shuts down both services; enabling/disabling the Host also enables/disables its timer.

At 04:00, maintenance checks whether the installed Pi version or clean source revision differs from the running one. It restarts only an idle Host and never downloads updates. Busy work, a dirty checkout, or an indeterminate state skips that run.

For service recovery before graphical login:

```bash
sudo loginctl enable-linger "$USER"
```

## Shell environment

Direct launches inherit the caller's exported environment. Linux services load the user's login/interactive shell exports once at startup, making normal shell-installed tools available to Pi and extensions. Running a launcher command that delegates to a service does not transfer that terminal's temporary environment into it.

| Variable | Meaning |
| --- | --- |
| `INSPIRE_ENVIRONMENT=inherit` | Use the supplied exports without shell discovery. |
| `INSPIRE_ENVIRONMENT=shell` | Load shell exports, including for a direct launch. |
| `INSPIRE_SHELL=/absolute/path/to/shell` | Override `SHELL` and the account default for discovery. |

Supported discovery shells are sh, Bash, Zsh, Fish, Dash, and Ksh. Windows direct launches inherit. Inspire preserves the user's `NODE_ENV` value; its Web server configures production HTTP behavior independently.

For persistent services, put overrides in a systemd user-service drop-in for the affected Host or terminal unit. Only exports are shared, not aliases or functions. Project terminal tabs also run their own shell initialization.

### Shell startup problems

Discovery runs from the home directory without a terminal and has a ten-second deadline. If shell startup opens a TUI or prompts, guard that interactive-only code with `INSPIRE_RESOLVING_ENVIRONMENT=1`, while leaving exports enabled. Discovery failure stops the new launch and reports the problem.

Older terminal units containing `NODE_ENV=production` need reinstallation. Apply the new unit when terminal processes can be ended:

```bash
./inspire service install-host
./inspire restart --all
```

A Host-only restart preserves the existing terminal daemon and its environment.

## Browser pairing

Pair once on a trusted browser profile. Inspire stores a non-extractable WebCrypto signing key in that origin's IndexedDB, alongside a public Host-authenticated registration certificate. The Host token is not stored in the browser. Reloads and Host restarts authenticate a one-use challenge with this key, then use a five-minute API bearer held only in page memory. Browser ports and tabs have independent API credentials; only tabs on the same origin share the stored pairing key. WebSocket connections use short-lived, single-use origin/audience tickets, not cookies or query-token authentication.

Local launch and status links contain a one-use, 30-second pairing transfer in the URL fragment, not the reusable Host token. The browser removes that transfer before pairing. If it expires, run `inspire status` for a fresh link. For manual remote pairing, run `inspire token` in a private terminal on the Host (or `npm run inspire -- token` from source); it verifies the matching Host before explicitly printing the shared credential. Do not copy that output into logs or a remote URL. HTTPS proxy URLs never pair through query tokens: use the Pair form instead. See [remote pairing](ssh-reverse.md#browser-pairing). WebCrypto and IndexedDB must be available (HTTPS or a browser-trusted loopback origin); blocked storage produces an error rather than a cookie fallback.

Every paired browser can operate the Host's Pi sessions, files and project terminals as your user account. Protect the browser profile and the Host token. Changing the Host token invalidates all stored registrations and API bearers; pair each browser again. Clearing the site's IndexedDB also requires pairing again. Explicit bearer headers remain available for trusted non-browser clients. File downloads stream complete raw bytes through a separate 15-second, single-use resource/session/origin transfer ticket; their URLs never contain the Host or API bearer, and large files do not inherit preview limits.

### Migration from cookie pairing

Generated cookie-era tokens (including 64-character tokens) rotate once on the next Host start to a distinct 86-character generation. The private plain-text `.token` file remains compatible with launcher readers. Reopen the launcher URL or use the new token to pair again. Existing Host-qualified and older unqualified pairing cookies are expired when that Host is visited; cookies never authenticate new HTTP or WebSocket clients. Other Host-qualified cookies and unrelated browser data are left alone.

**If you configured `INSPIRE_TOKEN` and previously paired a browser using cookies, rotate that configured token yourself before relying on the new port-isolation boundary.** Inspire cannot silently replace an operator-supplied secret. An old cookie can already contain a copy of that token; stopping cookie authentication does not revoke its explicit-bearer authority. Remove the old value from your secret configuration and restart the Host with its replacement. Old browser bundles must reload and pair; insecure cookie compatibility is not retained.

## Diagnostics

The Host writes rotated JSONL diagnostics in the per-user state directory:

| Platform | Directory |
| --- | --- |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/inspire` |
| macOS | `~/Library/Application Support/Inspire` |
| Windows | `%LOCALAPPDATA%\Inspire` |

A projection-conflict banner includes an incident ID for finding the corresponding record. Logs contain operation, process, timing, and persistence metadata, excluding prompts, tool output, extension payloads, credentials, and raw child stderr. POSIX directories/files use `0700`/`0600`; Windows uses the user-profile ACL boundary. Rotation retains five 5 MiB files by default. `INSPIRE_LOG_PATH` can select another file inside an existing private directory.

## Development checkout

Run `npm run dev` or `npm run inspire -- dev` from source. The coordinated entry starts the watching
Host and Vite, then prints/opens a one-use pairing link only after Vite owns its listener and the
matching Host proves readiness. It does not print a reusable token or open a guessed port.

Vite binds explicitly to `127.0.0.1:5173`; `INSPIRE_DEV_PORT` selects another frontend port. The
backend uses `INSPIRE_HOST`/`INSPIRE_PORT` (default `127.0.0.1:4587`), and every proxy route follows
that address. Both occupied ports fail explicitly. Choose a separate backend port when a normal
Host is already running; development never stops an unrelated listener or silently attaches to it.

Development uses a fresh per-run credential and private temporary control state, not an inherited
Host token, instance file or stop request. Each new development run pairs again; backend watch
reloads retain the run’s credential. `INSPIRE_OPEN=0` suppresses automatic opening. The printed
transfer expires after 30 seconds; Vite’s existing `o` + Enter action issues and opens a fresh link.
The `dev:host`/`dev:web` scripts are internal parts; use the coordinated entry for automatic pairing.

## Build and install a package

Inspire packages the browser client and compiled Node Host as a standalone npm CLI. Pi is a development dependency for compatibility checks; the installed application uses an external Pi package.

```bash
npm ci
npm run release:verify
npm pack
npm install --global ./inspire-pi-gui-0.5.5.tgz
inspire
```

Use the tarball name printed by `npm pack` if the package version has changed. `prepack` builds the release. Verification checks the exact tarball's contents and npm metadata, installs production dependencies, exercises the installed CLI, and starts an external Pi SDK/RPC session without a model call. CI runs the packaged lifecycle on Linux, macOS, and Windows.

For an updated source checkout, `inspire restart` rebuilds changed client inputs before replacing the Host. Pi extension changes can use the narrower [`/reload`](pi-commands.md#compaction-and-reload) operation.
