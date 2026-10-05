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

A direct local launch opens a one-time token URL. The browser exchanges it for an origin-scoped `HttpOnly`, `SameSite=Strict` cookie and removes the token from the URL. Normal launches reuse a private token for the installation, host, and port; `INSPIRE_TOKEN` can supply an explicit token.

A remote browser uses the Pair form through HTTPS. Its cookie is also `Secure`; see [remote pairing](ssh-reverse.md#browser-pairing). Every paired browser can operate the Host's Pi sessions and project terminals. Treat it as a full-control credential.

## Diagnostics

The Host writes rotated JSONL diagnostics in the per-user state directory:

| Platform | Directory |
| --- | --- |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/inspire` |
| macOS | `~/Library/Application Support/Inspire` |
| Windows | `%LOCALAPPDATA%\Inspire` |

A projection-conflict banner includes an incident ID for finding the corresponding record. Logs contain operation, process, timing, and persistence metadata, excluding prompts, tool output, extension payloads, credentials, and raw child stderr. POSIX directories/files use `0700`/`0600`; Windows uses the user-profile ACL boundary. Rotation retains five 5 MiB files by default. `INSPIRE_LOG_PATH` can select another file inside an existing private directory.

## Build and install a package

Inspire packages the browser client and compiled Node Host as a standalone npm CLI. Pi is a development dependency for compatibility checks; the installed application uses an external Pi package.

```bash
npm ci
npm run release:verify
npm pack
npm install --global ./inspire-pi-gui-0.4.0.tgz
inspire
```

Use the tarball name printed by `npm pack` if the package version has changed. `prepack` builds the release. Verification checks the exact tarball's contents and npm metadata, installs production dependencies, exercises the installed CLI, and starts an external Pi SDK/RPC session without a model call. CI runs the packaged lifecycle on Linux, macOS, and Windows.

For an updated source checkout, `inspire restart` rebuilds changed client inputs before replacing the Host. Pi extension changes can use the narrower [`/reload`](pi-commands.md#compaction-and-reload) operation.
