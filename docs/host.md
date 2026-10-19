# Running and maintaining Inspire

The Host runs Pi and serves the browser workbench. It binds to loopback; [reverse SSH](ssh-reverse.md)
provides optional remote ingress. Requirements and the quick start are in the
[README](../README.md#run-locally). Windows native controls require PowerShell 7 (`pwsh`).
Inspire uses its named PATH entry or standard Program Files installation and reports a missing
dependency rather than silently switching to the legacy Windows PowerShell engine.

Examples below use `./inspire` in a Linux/macOS source checkout. On every supported platform, use
`npm run inspire -- <arguments>`; a globally installed package exposes `inspire` directly.
In Windows PowerShell with script execution disabled, spell these commands `npm.cmd`,
`inspire.cmd` and `pi.cmd`. This selects npm's batch shim instead of its blocked `.ps1` shim,
without changing user or machine execution policy. For example: `inspire.cmd terminal status`
or `npm.cmd run inspire -- restart`.

## Lifecycle

| Command | Effect |
| --- | --- |
| `inspire` | Start or reopen the matching instance. |
| `inspire status` | Check the managed Host and print a fresh local pairing link. |
| `inspire token` | Explicitly print the verified Host token for manual pairing; keep this output private. |
| `inspire restart` | Prepare the next build/runtime, then restart the Host and its owned Pi workers. Preserve project terminals and connected external Pi sessions. |
| `inspire restart --all` | Restart this installation's Linux Host and terminal services; end terminal processes. |
| `inspire stop` | Stop the Host; also stop its installed terminal service. Direct-launch terminal daemons remain independent. |
| `inspire terminal status` | Inspect the matching authenticated terminal daemon without creating a new one. |
| `inspire terminal stop` | Stop that daemon; running terminals require `--force`. |
| `inspire terminal restart` | Replace that daemon, restoring saved tabs as exited. Running terminals require `--force`. |

A CLI restart stops Inspire-owned Pi workers; connected external Herdr sessions keep running.
In **Settings → System**, restart first checks for unfinished work. A refusal offers a separately confirmed **Stop work and restart**, which interrupts Pi work and discards Pending input. An idle worker does not block this check. Preparation failure leaves the current Host running; after a disconnect, the browser observes the submitted restart instead of sending another one.

**Restart Host** works from the page on native Windows, macOS, and Linux when started through
`inspire` (or `npm run inspire`), as well as with the installed Linux service. Direct page restart keeps
the existing launcher, environment, port, state path, pairing, and project terminals; it does not open
another browser window. Preparation failure leaves the Host running. Failed Pi cleanup prevents a
replacement. A Host started directly from an internal server entrypoint has no restart owner and must
be restarted by its operator.

Restart scopes leave connection services running. `--all` requires matching installed Linux services;
ordinary and full availability are shown separately. The launcher authenticates managed instances and
reports an unrelated port occupant for inspection rather than terminating it.

### Readiness and older Hosts

The CLI verifies a fresh, instance-bound server proof before reporting a Host as ready. Readiness
and scheduled maintenance never send the reusable Host token to a recorded port, and they do not
follow redirects or trust a Host-shaped health reply.

A Host started before this HTTP protocol needs one upgrade restart. If it already advertises
authenticated local shutdown, `inspire restart` can perform that upgrade on every supported platform.
Legacy Linux can use the exact-process signal fallback. Older Windows/macOS Hosts without that
shutdown capability must first stop through their existing service manager or inspected process
controls. The new CLI does not restore an unsafe HTTP bearer fallback.

### Host shutdown when HTTP is unavailable

Current managed Hosts advertise an authenticated local shutdown capability beside their instance
state. `inspire stop` and `inspire restart` use it without depending on the HTTP listener, on Windows,
macOS and Linux. Reuse the same port/state-path overrides as the running Host. The request binds the
exact instance and expires; it contains no plaintext Host token.

The Host performs normal worker/backend cleanup. Restart requires its authenticated clean result
and actual process exit, not a missing state file. If cleanup fails or the event loop cannot respond,
the command refuses replacement; it never guesses a PID or force-kills an unknown process. Hosts
started before this capability need one restart through their existing controls to acquire it.

### Terminal-service maintenance

A preserved terminal daemon is not upgraded by Host-only restart. On Windows, macOS and Linux,
manage its installation/Host/port-scoped lifecycle from an **external OS terminal**:

```sh
inspire terminal status
inspire terminal restart
# Explicitly confirm ending every live project terminal in this daemon:
inspire terminal restart --force
# Or stop it without starting a replacement:
inspire terminal stop --force
```

Do not run stop/restart from an Inspire project terminal: ending the daemon can terminate that
command before it can finish replacement. The command refuses that environment before stopping work.
Status is read-only and can run there.

Reuse the Host's `INSPIRE_HOST`, `INSPIRE_PORT`, `INSPIRE_TERMINAL_DAEMON_ADDRESS`,
`INSPIRE_TERMINAL_TOKEN_PATH` and `INSPIRE_TERMINAL_STATE_PATH` overrides when applicable.
The command starts no Host, does not restart Pi workers, and never guesses a PID. It authenticates
the endpoint and binds its configuration, process birth and incarnation before requesting shutdown.
Running terminals need `--force`; this confirms ending their work, not permission to bypass
authentication or kill unknown processes. Saved tabs return as exited without rerunning commands.

A failed or unconfirmed PTY cleanup prevents replacement. The lifecycle control channel stays
available to inspect/retry a failed owner while terminal writes are fenced. Missing endpoints are
reported as not listening, not as proof of process exit. A dedicated daemon lifetime lock also
protects startup/drain handoff. The installed Linux terminal unit retains its service supervisor;
portable maintenance does not restart the Host or expand `Restart all`.

The authenticated terminal IPC upgrade needs a terminal-service restart, not only a Host restart.
Finish terminal work first. A still-listening old daemon is never killed or silently replaced by a new
Host; its input and output remain with that process. New daemons use a fresh private TLS secret at
`<terminal-token-path>.tls-v3`, rather than trusting the token used by the old plaintext protocol.
The configured token-path stem remains compatible with existing service arguments. Custom token/socket
paths on POSIX need an existing current-user-private parent, or a new parent Inspire can create at
`0700`. Inspire refuses shared parents without changing their permissions.

Daemons from before lifecycle controls need a one-time upgrade through their existing owner.
Installed Linux services can use `Restart all` after finishing terminal work. For older direct/native
instances, stop the Host, inspect the current user's exact terminal daemon, and stop that process tree
manually once. On macOS, inspect `ps -axo user,pid,command` (the process title may be
`inspire-terminal`) and use `lsof` to correlate its socket and working directory before sending
`kill -TERM <pid>`. On Windows, inspect Process ID and CommandLine with Task Manager or
`Get-CimInstance Win32_Process`, then use `taskkill /PID <pid> /T /F` for the verified daemon tree.
Do not terminate unrelated Node processes or use an unverified listener's claimed PID. Later
upgrades use the authenticated `inspire terminal` controls.

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

For persistent services, put overrides in a systemd user-service drop-in for the affected Host or terminal unit. Only exports are shared, not aliases or functions. Project terminal tabs also run their own shell initialization. Windows Pi/shell discovery respects
case-insensitive environment names and quoted PATH directories, including paths containing spaces or
semicolons.

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

## Recover a deleted session

Hidden → Restore only unhides a session. A deleted session must be recovered from the operating
system's Trash, if available; confirmed deletion permanently removes it when Trash cannot accept it.

On Windows/macOS, recover the complete **Inspire session recovery** folder from Recycle Bin, or
drag it out of macOS Trash. Follow its README, or run:

```sh
inspire recover-session "<bundle-folder>"
```

In a source checkout, use `node <path-to-inspire.mjs> recover-session "<bundle-folder>"`.
Relative folders resolve from the directory where you invoked the command. Typed `~`/`~/` (and
Windows `~\`) resolve against the Host account's home; the same rules apply to upload-storage trust
paths and project-directory input. Recovery starts no Host
or Pi worker. It validates the manifest and exact payload, supports a source on another volume, and
atomically restores the original physical session path without overwriting any existing file.
The original storage directory must still exist and support hard links for atomic no-clobber
publication; unsupported storage fails without overwriting the destination. The complete recovery
folder remains after success;
verify the recovered session before removing that folder. Hidden/pinned preferences are not restored.

Recover promptly after moving a folder outside known Pi storage/Trash locations: arbitrary external
folders are not scanned to retain uploaded attachments. On macOS, native per-volume Trash is included;
denied or indeterminate Trash access defers upload collection instead of deleting uncertain content.

Linux uses the home Freedesktop Trash when it shares the source mount; otherwise it uses validated
current-user Trash on the session volume. The desktop's normal Restore action returns the original
session path. If no safe compatible Trash is available, confirmed deletion still uses the permanent
fallback.

### Uploaded-file retention and storage migration

Upload collection includes known source-volume Trash. Registered session directories carry a small,
non-secret `.inspire-upload-retention-root.json` continuity marker. Keep it when backing up or moving
the complete directory. The upload registry retains the expected marker identity across Host restarts
on every platform; an existing path, drive letter, device number or valid Pi header alone cannot
establish continuity. The marker identifies the directory namespace, not physical disk hardware. The registry separately
binds its volume/Trash scope: Windows uses the volume GUID plus filesystem-format identity, macOS the
volume UUID, and Linux an independent private volume marker outside the session tree. A copied
session directory alone cannot establish continuity of the old volume's Trash.

A missing, replaced, unreadable or unverified root defers collection. So do unreadable Trash and
a storage change during scanning. Opening/sending sessions does not fail solely because a read-only
directory cannot accept the marker. Registered markers are never silently recreated or rebound.
Reconnect/restore the original directory including its marker first.

Older registries have no historical marker identity. Stop **every Host sharing this upload store**,
make sure the complete original sessions and their Trash references are available, then preview and
explicitly accept the verified directory:

```sh
inspire uploads trust-session-directory "<session-directory>"
inspire uploads trust-session-directory "<session-directory>" --confirm
```

Relative paths resolve from the invocation directory. Preview writes nothing. Confirmation updates
all affected retained upload registries under the same user-state attachment parent. It refuses
active owners and conflicting valid markers; the maintenance lock coordinates current-version
writers. Legacy Hosts without that lock protocol must be stopped by the operator. New session
activity does not automatically migrate an old registry. Mistaken trust of incomplete/replacement
storage can release uploaded files; do not remove the registry to bypass the refusal.

For a deliberately replaced/migrated namespace, first recover any sessions you still need from the
old native Trash and include all their references in the new storage. Inspect the preview's previous
identities and current volume, then explicitly accept replacement only after that verification:

```sh
inspire uploads trust-session-directory "<session-directory>" --confirm --accept-replacement
```

Replacement acceptance updates registry expectations; it does not overwrite existing valid directory
or volume markers. Unidentified native/network volumes, or Linux volumes with no safe independent
anchor location, defer collection instead of falling back to a pathname/device-number guess.

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

Use the tarball name printed by `npm pack` if the package version has changed. `prepack` builds the release. Verification checks the exact tarball's contents and npm metadata, installs production dependencies, exercises the installed CLI, and starts an external Pi SDK/RPC session without a model call. CI runs the packaged lifecycle on Linux, macOS, and Windows, including the default authenticated terminal daemon, real PTY input/output, ordinary page restart preserving the live terminal and retiring an idle Pi worker, and original-path recovery through the installed CLI.

For an updated source checkout, `inspire restart` rebuilds changed client inputs before replacing the Host. Pi extension changes can use the narrower [`/reload`](pi-commands.md#compaction-and-reload) operation.
