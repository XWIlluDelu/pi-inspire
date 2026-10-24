# Running and maintaining Inspire

The Host runs Pi and serves the browser workbench. It binds to loopback; [reverse SSH](ssh-reverse.md)
provides optional remote ingress. Requirements and the quick start are in the
[README](../README.md#run-locally). Windows native controls require PowerShell 7 (`pwsh`).
Inspire looks on PATH and in the standard Program Files installation; legacy Windows PowerShell
is not supported.

Examples below use `./inspire` in a Linux/macOS source checkout. On every supported platform, use
`npm run inspire -- <arguments>`; a globally installed package exposes `inspire` directly.
In Windows PowerShell with script execution disabled, spell these commands `npm.cmd`,
`inspire.cmd` and `pi.cmd`. This selects npm's batch shim instead of its blocked `.ps1` shim,
without changing user or machine execution policy. For example: `inspire.cmd terminal status`
or `npm.cmd run inspire -- restart`.

## Task notifications

In **Settings → Behavior → Task alerts**, choose **System notification** on each device that
should receive alerts. Normal completion and errors notify you when you are away from the
conversation; confirmed Stop does not. Each session keeps one system notification: a newer result
replaces its older result, while different sessions remain separate. Titles include the saved
session name (or **Unnamed session**) and can appear on the lock screen; the body identifies the
project without message text or error details. New results can alert again, but duplicate or delayed
older delivery does not re-alert. **Mark tab** stays local to open pages.

Click **Enable notifications** on that device, allow browser permission, then check for
**Background notifications enabled**. Selecting **System notification** alone does not complete setup.
**While Inspire is open** means background delivery is unavailable; permitted alerts still work
while the page is open. Settings explains setup failures. Reopening Inspire or Settings retries an
interrupted Host registration without asking for permission again; an expired subscription requires
**Enable notifications** to replace it.

To verify a device, first send a test and look for **Inspire test notification** in its system
notification center. Then move away from a running conversation (or close Inspire's page without
force-stopping the browser) and let the task finish; expect **Task completed** or **Task failed**.
A focused view of the same conversation suppresses the ordinary task alert, but not the test.
If a display was accepted but no banner appears, check site permission, the OS notification center,
Do Not Disturb/Focus, and the browser's notification settings. Repeat on each desktop browser and
phone: permission and enrollment do not transfer between origins, browser profiles, or devices.

The Host must stay running and reach the browser's HTTPS push service. It uses `HTTPS_PROXY`
when configured; do not put credentials in project files. Push does not need public inbound
access to the Host. Opening the conversation still requires access to its normal URL, including
VPN or reverse-SSH connectivity when applicable. Remote phones need trusted HTTPS; iPhone/iPad
users must add Inspire to the Home Screen and enable notifications in that app. Fully exiting or
force-stopping the browser can prevent delivery.

Alert choices are device-local. A new browser starts Off. Existing paired browsers retain their
old alert choice, but must explicitly enable background delivery. Reset preferences affects alerts
only on the current device. Protected notification state sits beside the Host preferences file as
`<preferences-path>.notifications-<authority-namespace>.json`; it contains VAPID/subscription
secrets and must not be published. Pending alerts expire after 15 minutes rather than becoming
an inbox.

Connected native Pi uses the updated [Inspire session bridge extension](extensions.md#control-the-same-herdr-pi-terminal)
to distinguish completion, failure and cancellation. Reload it in the original idle terminal after
updating; a Host restart does not reload an external Pi. Older integrations can report **Task ended**
without claiming a successful result.

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

In **Settings → System → Host**, restart checks for unfinished work. A refusal offers a separately
confirmed **Stop work and restart**, which interrupts Inspire-owned Pi work and discards Pending
input. Idle workers do not block an ordinary restart. After a disconnect, the browser tracks the
submitted restart without sending another one.

**Recheck status** still reads the Host when this browser's local restart recovery record is
unreadable. If storage recovers, Recheck restores the controls. **Clear local restart record…**
lets you explicitly discard broken or unwanted browser tracking; it does not send or cancel a
restart. A restart already pending on the Host still blocks a new one.

**Restart Host** works from the page on native Windows, macOS, and Linux when started through
`inspire` (or `npm run inspire`), as well as with the installed Linux service. Direct page restart keeps
the launcher, environment, instance configuration, pairing and project terminals without opening
another browser window. Preparation failure leaves the Host running; failed Pi cleanup prevents
replacement. A Host started directly from an internal server entrypoint must be restarted by its operator.

Restart scopes leave connection services running. `--all` requires matching installed Linux services;
ordinary and full availability are shown separately. The launcher authenticates managed instances and
reports an unrelated port occupant for inspection rather than terminating it.

### Readiness and older Hosts

The CLI authenticates the matching instance before reporting readiness. Older Hosts without this
readiness protocol need one upgrade restart. If a Host already advertises authenticated local
shutdown, `inspire restart` can perform that upgrade on every supported platform.
Legacy Linux can use the exact-process signal fallback. Older Windows/macOS Hosts without that
shutdown capability must first stop through their existing service manager or inspected process
controls. See the [ownership contract](https://github.com/XWIlluDelu/pi-inspire/blob/main/docdoki/specs/host-lifecycle.md#process-lock-and-service-ownership)
for the authentication and replacement boundaries.

### Host shutdown when HTTP is unavailable

`inspire stop` and `inspire restart` can reach a current managed Host even when its HTTP listener
is unavailable, on Windows, macOS and Linux. Reuse the running Host's port/state-path overrides.

Restart waits for clean worker/backend shutdown and actual process exit. If cleanup fails or the
Host cannot respond, replacement is refused. Hosts predating this capability need one restart
through their existing controls.

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
These commands leave the Host and Pi workers running. `--force` confirms ending live terminals;
it does not bypass authentication. Saved tabs return as exited without rerunning commands.

Failed or unconfirmed PTY cleanup prevents replacement and blocks terminal writes. Status and
lifecycle controls remain available for inspection and retry. A missing endpoint means it is not
listening, not that its process has exited. The installed Linux terminal unit retains systemd
ownership. [Terminal ownership](https://github.com/XWIlluDelu/pi-inspire/blob/main/docdoki/specs/terminal.md#process-ownership) defines the handoff.

### Connection recovery and upgrades

Compatible terminal services reconnect without restarting the Host. If startup connection fails,
later terminal requests retry authentication on demand; there is no background restart loop and no
automatic replay of terminal input or dispatched controls. Missing optional maintenance controls
do not disable a compatible data connection.

Inspect `inspire terminal status` and the owning service before choosing maintenance. A failed
connection check or unavailable maintenance control alone does not establish a terminal-data
protocol mismatch. The error card keeps the connection detail available to read and copy.

Installing or enabling Linux units does not migrate an existing transient daemon or stop its work.
A confirmed duplicate listener exits with code 78; the terminal unit does not crash-restart that
conflict, while recoverable crashes still use its normal restart policy. A compatible existing daemon
can continue serving the Host. An incompatible owner needs an explicit migration after its terminal
work is finished; the failed installed unit does not prove that the old owner's PTYs have ended.

The authenticated terminal IPC upgrade needs a terminal-service restart, not only a Host restart.
Finish terminal work first. A still-listening old daemon is never killed or silently replaced by a new
Host; its input and output remain with that process. New daemons use a fresh private TLS secret at
`<terminal-token-path>.tls-v3`, rather than trusting the token used by the old plaintext protocol.
The configured token-path stem remains compatible with existing service arguments. Custom token/socket
paths on POSIX need an existing current-user-private parent, or a new parent Inspire can create at
`0700`. Inspire refuses shared parents without changing their permissions.

Daemons from before lifecycle controls need a one-time upgrade through their existing owner.
Installed Linux services can use **System → Host → Restart all** after finishing terminal work,
but that scope does not retire an independent transient owner. Inspect its exact owning service
before deliberately stopping it; that action ends its live PTYs. For older direct/native
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

Installation writes `inspire-host.service`, `inspire-terminal.service` and an optional maintenance
timer. Matching launcher commands delegate to these units; inheriting the default host, port and
state path still selects the managed instance. Stop or disable shuts down both services. Enabling
the Host leaves scheduled maintenance off; disabling it also disables the timer.

If you explicitly want automatic maintenance, enable it separately with `systemctl --user enable --now inspire-idle-maintenance-restart.timer`; use `disable --now` to turn it off. At 04:00, the enabled timer checks whether the installed Pi version or clean source revision differs from the running one. It restarts only an idle Host and never downloads updates. Busy work, a dirty checkout, or an indeterminate state skips that run.

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

Pair once per browser profile and origin. Pairing survives reloads and Host restarts by keeping a
non-extractable signing key in the origin's IndexedDB; the Host token is not stored in the browser.
Tabs on the same origin share pairing, while different ports require separate pairing. WebCrypto
and IndexedDB must be available on trusted HTTPS or loopback.

Local launch and status links carry a one-use pairing transfer that expires after 30 seconds.
Run `inspire status` for a fresh link. For manual remote pairing, run `inspire token` in a private
Host terminal (or `npm run inspire -- token` from source), then enter it in the Pair form.
Keep the output out of logs and URLs; HTTPS proxy URLs do not accept query-token pairing.
See [remote pairing](ssh-reverse.md#browser-pairing).

Every paired browser can operate Pi sessions, files and project terminals as the Host account.
Protect the browser profile and Host token. Token rotation or clearing the site's IndexedDB requires
pairing again. Trusted non-browser clients can use explicit bearer headers. File downloads retain
complete raw bytes, independently of preview limits; download URLs contain no Host or API bearer.
The [pairing contract](https://github.com/XWIlluDelu/pi-inspire/blob/main/docdoki/specs/host-lifecycle.md#pairing-and-authenticated-ingress) defines
credential, ticket and origin boundaries.

### Migration from cookie pairing

Generated cookie-era tokens rotate once on the next Host start. Reopen the launcher URL or use
the new token to pair again. Visiting the Host expires its old pairing cookies without clearing
unrelated browser data; cookies no longer authenticate connections.

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
Windows `~\`) resolve against the Host account's home; the same rules apply to project-directory input. Recovery starts no Host
or Pi worker. It validates the manifest and exact payload, supports a source on another volume, and
atomically restores the original physical session path without overwriting any existing file.
The original storage directory must still exist and support hard links for atomic no-clobber
publication; unsupported storage fails without overwriting the destination. The complete recovery
folder remains after success;
verify the recovered session before removing that folder. Hidden/pinned preferences are not restored.

Delivered ordinary attachments are retained independently of session storage and Trash. Moving a
recovery folder or keeping an offline backup does not release its referenced upload copies.

Linux uses the home Freedesktop Trash when it shares the source mount; otherwise it uses validated
current-user Trash on the session volume. The desktop's normal Restore action returns the original
session path. If no safe compatible Trash is available, confirmed deletion still uses the permanent
fallback.

### Uploaded-file retention and cleanup

Unsent uploads are temporary. Withdrawing a staged upload or shutting down its owner removes its
copy. Periodic cleanup also reclaims recorded, explicitly unsubmitted uploads after their owning
process has exited. A live or unverified owner keeps its staging.

Before handing an upload to Pi, the Host records that delivery is possible. Ordinary files then
remain durable assets across restart, forks, session deletion, backups and native Trash. Lost
receipts and interrupted sends preserve those copies too. Accepted images live in Pi history and
release their temporary upload copies. Existing ownership records are retained without rewriting
paths or requiring migration.

This favors reliable references over automatic disk reclamation. To reclaim delivered assets,
explicitly select the files you no longer need under the per-user state directory's
`attachments/<owner-directory>/` (platform locations are listed under Diagnostics). Stop work using
those files, then remove the selected UUID-prefixed payload and its matching `<uuid>.json` ownership
record. Removing a payload breaks **every** session, backup or tool reference to it; Inspire does
not claim to discover all such references. Do not remove an entire attachment directory unless all
its contents are disposable.

Session-directory registries, continuity markers and volume anchors from older versions are no
longer used or updated; no offline upload-storage trust migration is required. Upgrade Hosts sharing
the store to apply the durable-asset policy: older versions retain their earlier automatic collection
behavior. Leave legacy metadata alone until those older Hosts have been stopped or upgraded.

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
Host and Vite, then prints/opens a one-use pairing link after both are ready.

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
npm install --global ./inspire-pi-gui-0.6.0.tgz
inspire
```

Use the tarball name printed by `npm pack` if the version has changed; `prepack` builds the release.
`release:verify` checks the tarball and its production-only installation, including the CLI and an
external Pi SDK/RPC session without a model call. CI exercises the packaged lifecycle on Linux,
macOS and Windows. [Platform evidence](https://github.com/XWIlluDelu/pi-inspire/blob/main/docdoki/notes/platform-compatibility.md#verified-native-baseline)
records the checked source versions and scope.

For an updated source checkout, `inspire restart` rebuilds changed client inputs before replacing the Host. Pi extension changes can use the narrower [`/reload`](pi-commands.md#compaction-and-reload) operation.
