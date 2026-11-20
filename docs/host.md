# Running and maintaining Inspire

The Host runs Pi and serves the browser workbench. It binds to loopback;
[reverse SSH](ssh-reverse.md) provides optional remote access. The
[README](../README.md#run-locally) covers requirements, platform support, installation and your
first session. This guide covers Host configuration, pairing, daily commands and maintenance.

| Task | Where to go |
| --- | --- |
| Start or configure the Host | [Run and reopen](#run-and-reopen), [Shell environment](#shell-environment) |
| Connect a browser or install the app | [Browser pairing](#browser-pairing), [Installed browser apps](#installed-browser-apps), [Remote access](ssh-reverse.md) |
| Use a running Host | [Lifecycle commands](#lifecycle), [Task notifications](#task-notifications) |
| Maintain or upgrade | [Host and terminal maintenance](#host-and-terminal-maintenance), [Linux user services](#linux-user-services), [Updating Inspire](#updating-inspire) |
| Recover data or investigate errors | [Session recovery](#recover-a-deleted-session), [Uploaded files](#uploaded-file-retention-and-cleanup), [Diagnostics](#diagnostics) |
| Work from source or distribute a build | [Development checkout](#development-checkout), [Build and install a package](#build-and-install-a-package) |

## Run and reopen

Commands in this guide use the globally installed `inspire` entry. From a source checkout, use
`npm run inspire -- <arguments>` (or `./inspire <arguments>` on Linux/macOS). With restricted
Windows PowerShell, use the [batch shims from the README](../README.md#run-locally).

A direct launch stays attached to its terminal. Use [Linux user services](#linux-user-services)
to keep it running after the terminal closes. Closing the browser leaves the Host running.

Set overrides in the environment that launches the Host:

| Variable | Meaning |
| --- | --- |
| `INSPIRE_HOST` | Loopback address: `127.0.0.1` (default), `::1`, or `localhost`. Remote access goes through an HTTPS ingress such as reverse SSH. |
| `INSPIRE_PORT` | Decimal TCP port from 1 to 65535, default `4587`. Use a separate port for another Host or a development instance. |
| `INSPIRE_OPEN=0` | Do not open a browser automatically; the launcher still prints a local pairing link. |
| `INSPIRE_PI_COMMAND` | A specific Pi executable, by name or path, instead of `pi` on PATH. It must resolve to the Pi package, not a shell command with arguments. |
| `INSPIRE_STATE_PATH` | Private launcher instance-state file. Normally unset; if set, reuse it for that instance's status, stop and restart commands. |
| `INSPIRE_HERDR_ENV_EXCLUDE` | Comma-separated environment prefixes kept out of the shared Herdr server; see [Herdr worker placement](#herdr-worker-placement). |

Manage an instance with the same installation, address, port and state-path override that started
it. The launcher reports an unrelated program on the port instead of terminating it. Services use
their configured environment; see [Shell environment](#shell-environment).

If startup reports that Pi is missing, check the separate Pi installation and the Host's PATH. The
Pi development dependency inside a checkout is not used at runtime. If the browser opens but no
model is available, use **Manage models** and the
[model settings and login guide](pi-commands.md#model-settings-and-login). Keep the launch
terminal's exact error for [Diagnostics](#diagnostics).

## Shell environment

Direct launches inherit the caller's exported environment. Linux services load the user's
login/interactive shell exports once at startup, so shell-installed tools are available to Pi and
extensions. A launcher command that delegates to a running service does not pass that terminal's
temporary environment to it.

| Variable | Meaning |
| --- | --- |
| `INSPIRE_ENVIRONMENT=inherit` | Use the supplied exports without shell discovery. |
| `INSPIRE_ENVIRONMENT=shell` | Load shell exports, including for a direct launch. |
| `INSPIRE_SHELL=/absolute/path/to/shell` | Shell used for discovery, overriding `SHELL` and the account default. |

Discovery supports sh, Bash, Zsh, Fish, Dash and Ksh. Windows direct launches always inherit;
Windows Pi lookup handles case-insensitive variable names and quoted PATH entries, including
paths with spaces or semicolons.
Only exports are shared, not aliases or functions; project terminal tabs run their own shell
initialization. `NODE_ENV` is passed through unchanged. For persistent services, put overrides in a
systemd user-service drop-in for the Host or terminal unit.

### Shell startup problems

Discovery runs from the home directory without a terminal and has a ten-second deadline. If shell
startup opens a TUI or prompts, skip that interactive code when `INSPIRE_RESOLVING_ENVIRONMENT=1`
and keep the exports. A discovery failure stops the launch and reports the problem.

## Browser pairing

Pair once per browser profile and origin. Pairing survives reloads and Host restarts: the browser
keeps a non-extractable signing key in the origin's IndexedDB, never the Host token. Tabs on the same
origin share pairing; a different port is a different origin. WebCrypto and IndexedDB require HTTPS
or loopback.

Launch and status links carry a one-use pairing transfer that expires after 30 seconds; run
`inspire status` for a fresh one. For manual remote pairing, run `inspire token` in a private Host
terminal and enter the token in the Pair form. Keep it out of logs and URLs; HTTPS proxy URLs do not
accept a token in the query string. See [remote pairing](ssh-reverse.md#browser-pairing).

Every paired browser can operate Pi sessions, files and project terminals as the Host account, so
protect the browser profile and the token. Rotating the token or clearing the site's IndexedDB
requires pairing again. Trusted non-browser clients can send an explicit bearer header. Download
URLs contain no bearer credential, and downloads deliver the complete file regardless of preview
limits. The [pairing contract](https://github.com/XWIlluDelu/pi-inspire/blob/main/docdoki/specs/host-lifecycle.md#pairing-and-authenticated-ingress)
defines the credential, ticket and origin boundaries.

## Installed browser apps

On a trusted HTTPS origin, use the browser's **Install app** or **Add to Home Screen** action. The
installed app uses the same Host and project data, so the Host and any remote connection must stay
available. Enable [task notifications](#task-notifications) separately on that device.

The page supplies a dynamic theme hint. Android's browser and OS control the system navigation
area. If the installed app keeps older colors after a manifest update, compare the same page in a
Chrome tab and let the existing installation update.
See [Chrome's manifest update process](https://web.dev/articles/manifest-updates#updates_on_chrome_for_android).

## Lifecycle

| Command | Effect |
| --- | --- |
| `inspire` | Start or reopen the matching instance. |
| `inspire status` | Check a running Host and print a fresh local pairing link. |
| `inspire token` | Print the verified Host token for manual pairing; keep this output private. |
| `inspire restart` | Prepare the next build and runtime, then restart the Host and its own Pi workers. Project terminals keep running. |
| `inspire restart --terminals` | Restart the Linux Host and terminal services, closing project terminals. |
| `inspire restart --all` | Close current-user Pi sessions, then restart the Linux Host and terminals. Include Herdr Pi when enhancement is active. |
| `inspire stop` | Stop the Host and its installed terminal service. A direct-launch terminal daemon keeps running. |
| `inspire terminal status` | Inspect the matching terminal daemon without creating one. |
| `inspire terminal stop` / `restart` | Stop or replace the daemon. See [terminal-service maintenance](#terminal-service-maintenance). |

## Task notifications

In **Settings → Behavior → Task alerts**, choose **System notification** and allow the browser
permission. **Background notifications enabled** confirms enrollment. **While Inspire is open**
means delivery uses the open page. Reopening Inspire or Settings can repair the Host registration
for an existing subscription. Use **Enable notifications** to retry setup or replace an expired
subscription.

Completions and errors notify you when you are away from the conversation; a confirmed Stop does
not. **Notification grouping** chooses **Session** (default) or **Project** on this device, and a
newer result replaces the group's older notification. Project grouping shows the session name for
one conversation or **n sessions** for several; repeated runs in one session count once.
Dismissing or clicking a notification resets its count, and viewing one session leaves its unread
project peers in place. Changing grouping clears existing notifications without affecting
permission or enrollment. **Mark tab** uses the browser tab indicator.

Titles show the saved session name (or **Unnamed session**) and can appear on the lock screen; the
body names the project, never message text or error details. Duplicate or delayed delivery of an
older result does not alert again.

To verify a device, send a test and look for **Inspire test notification** in the system
notification center. Then leave a running conversation (or close Inspire's page without
force-stopping the browser) and let the task finish; expect **Task completed** or **Task failed**.
Viewing the same conversation suppresses the task alert, but not the test. If nothing appears,
check site permission, the OS notification center, Do Not Disturb/Focus and the browser's
notification settings. Permission and enrollment are per origin, browser profile and device.

The Host must stay running and reach the browser's HTTPS push service; it honors `HTTPS_PROXY`.
Push needs no inbound access to the Host, but opening the conversation still needs its normal URL
(including VPN or reverse SSH). Remote phones need trusted HTTPS; on iPhone/iPad, add Inspire to the
Home Screen and enable notifications in that app. Force-stopping the browser can prevent delivery.

Alert choices and Reset apply to this browser installation, which defaults to Off. Pending alerts
expire after 15 minutes. Notification state, including VAPID and
subscription secrets, is stored beside the preferences file as
`<preferences-path>.notifications-<authority-namespace>.json`; do not publish it.

A terminal Pi reports completion, failure and cancellation through
[attach-control](extensions.md#share-sessions-with-terminal-pi). After updating it, run `/reload` in
that Pi to apply the update.

## Host and terminal maintenance

In **Settings → System → Host**, **Restart** replaces Inspire and its own Pi workers.
Attached Pi processes and project terminals stay open. Use `/reload` in a terminal Pi to
reload its resources. If work is active, the Host identifies it and offers **Stop work and
restart**. If Stop remains unconfirmed, review the affected sessions before choosing
**Restart anyway**.

**Restart all** closes current-user Pi sessions and project terminals on installed Linux
services. The running Host's enhancement mode determines whether Herdr Pi are included.
The shared Herdr server stays up. Inspire starts again after Pi shutdown succeeds.

The page follows the restart in the background and retains browser pairing. Ordinary restart
requires a launcher or installed service. A Host started directly from the internal server
entry needs an operator restart. If the listener is down, run `inspire stop` with the same
port and state-path overrides and start it again after shutdown.

Run CLI `--terminals` and `--all` from an external OS terminal. Run `--all` outside Pi so
the restart command survives Pi shutdown. Connection services continue across restarts.

### Terminal-service maintenance

Run `inspire terminal stop` or `inspire terminal restart` from an external terminal. Add
`--force` to close live terminals. Saved tabs reopen as exited and the Host keeps running.

Use the same `INSPIRE_HOST`, `INSPIRE_PORT`, `INSPIRE_TERMINAL_DAEMON_ADDRESS`,
`INSPIRE_TERMINAL_TOKEN_PATH` and `INSPIRE_TERMINAL_STATE_PATH` overrides as the Host.
Failed or unconfirmed PTY cleanup blocks terminal writes and replacement.
Status and lifecycle controls remain available. An absent socket alone cannot confirm process exit.

### Connection recovery and upgrades

The terminal service reconnects on demand after a connection failure. It does not replay terminal
input or controls. Inspect `inspire terminal status` and the owning service. The error card keeps
the connection detail for copying.

After enabling the Linux units, a compatible terminal daemon retained from a direct launch keeps
serving the Host. `inspire restart --terminals` affects the installed terminal service. The retained daemon keeps
running, and the installed daemon can exit with code 78 when it finds that owner. To move terminal
ownership to the installed service, finish terminal work, run `inspire terminal stop` from an
external OS terminal, then run `systemctl --user start inspire-terminal.service`. See
[Updating Inspire](#updating-inspire) to replace an older daemon.

Custom token or socket paths on POSIX need a parent directory private to the current user, or one
Inspire can create with mode `0700`; Inspire refuses shared parents and does not change their
permissions.

## Linux user services

Before moving a direct launch to services, finish its Pi work and run `inspire stop` from an
external terminal. This stops the direct Host but not an independent terminal daemon; see
[Connection recovery and upgrades](#connection-recovery-and-upgrades).

```bash
inspire service install-host
inspire service enable-host
```

This installs `inspire-host.service`, `inspire-terminal.service` and an optional maintenance timer.
Launcher commands for the default host, port and state path then manage these units. Stop or
disable shuts down both services.

Scheduled maintenance stays off unless you enable it with
`systemctl --user enable --now inspire-idle-maintenance-restart.timer` (`disable --now` turns it
off; disabling the Host also disables it). At 04:00 it restarts an idle Host if the installed Pi
version or the clean source revision differs from the running one. It never downloads updates and
skips busy work, a dirty checkout or an indeterminate state.

To start services before graphical login:

```bash
sudo loginctl enable-linger "$USER"
```

## Herdr worker placement

Enable **Settings → System → Host → Herdr enhancement** to run Inspire's own Pi workers in Herdr
panes. This optional mode requires Linux, Herdr, a systemd user manager, and writable cgroup v2
scopes with `cgroup.kill`. Settings shows unavailable prerequisites; the saved choice takes effect
after a Host restart. The default direct mode needs no Herdr, and terminal Pi sessions are shared
through attach-control wherever they run.

The shared Herdr server never inherits `INSPIRE_*` variables. If an extension keeps a per-process
identity in environment variables that must not leak into other panes, list their prefixes in the
Host environment as `INSPIRE_HERDR_ENV_EXCLUDE=PREFIX_A_,PREFIX_B_` and restart the Host. Nothing
else is excluded by default.

## Recover a deleted session

Hidden → Restore only unhides a session. A deleted session can be recovered from the operating
system's Trash; if Trash cannot accept it, confirmed deletion is permanent.

On Windows or macOS, restore the complete **Inspire session recovery** folder from the Recycle Bin
or Trash, then follow its README or run:

```sh
inspire recover-session "<bundle-folder>"
```

From a source checkout, run `node <path-to-inspire.mjs> recover-session "<bundle-folder>"`.
Relative paths resolve from the current directory, and `~`/`~/` (and `~\` on Windows) from the Host
account's home. Recovery starts no Host or Pi worker. It validates the manifest and payload, accepts
a source on another volume, and restores the original session path atomically without overwriting
an existing file; this needs the original storage directory to exist and support hard links. The
recovery folder remains afterwards, so verify the session before deleting it. Hidden and pinned
preferences are not restored.

On Linux, deletion uses the home Freedesktop Trash when it is on the same mount, otherwise a
validated current-user Trash on the session's volume; the desktop's Restore action returns the
original path. Without a safe Trash, confirmed deletion is permanent.

Delivered attachments are stored separately from sessions and Trash; moving a recovery folder or
keeping a backup does not release them.

### Uploaded-file retention and cleanup

Unsent uploads are temporary: withdrawing one or ending its owner removes its copy, and periodic
cleanup reclaims unsubmitted uploads whose owner has exited. A live or unverified owner keeps its
staging.

Before handing an upload to Pi, the Host records that it may be delivered. From then on, ordinary
files are durable across restarts, forks, session deletion, backups and Trash, including after a
lost receipt or interrupted send. Accepted images live in Pi history and release their temporary
copies.

Inspire favors reliable references over automatic reclamation. To free space, choose the delivered
files you no longer need under `attachments/<owner-directory>/` in the per-user state directory
(locations under [Diagnostics](#diagnostics)). Stop work that uses them, then delete the
UUID-prefixed payload and its `<uuid>.json` record. Deleting a payload breaks **every** session,
backup or tool reference to it, and Inspire cannot find all such references, so do not delete a
whole attachment directory unless everything in it is disposable.

## Diagnostics

The Host writes rotated JSONL diagnostics in the per-user state directory:

| Platform | Directory |
| --- | --- |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/inspire` |
| macOS | `~/Library/Application Support/Inspire` |
| Windows | `%LOCALAPPDATA%\Inspire` |

For a conversation conflict, find the `projection_conflict` record by session ID and time. Its
incident ID correlates recovery records. Logs contain operation, process, timing and persistence
metadata. Files are private (`0700`/`0600` on POSIX, the user-profile ACL on Windows). Rotation
keeps five 5 MiB files. `INSPIRE_LOG_PATH` selects another file inside an existing private directory.

## Development checkout

`npm run dev` (or `npm run inspire -- dev`) starts the watching Host and Vite, then prints and opens
a one-use pairing link once both are ready. The `dev:host` and `dev:web` scripts are internal parts
of this entry.

Vite binds to `127.0.0.1:5173` (`INSPIRE_DEV_PORT` changes the port). The backend uses
`INSPIRE_HOST`/`INSPIRE_PORT` (default `127.0.0.1:4587`), and the proxy follows it. An occupied port
is an error: choose a separate backend port when a normal Host is running.

Each development run uses fresh credentials and private temporary control state, so it pairs again;
backend reloads keep the run's credentials. `INSPIRE_OPEN=0` suppresses opening the browser. The
printed link expires after 30 seconds; Vite's `o` + Enter opens a fresh one.

## Build and install a package

```bash
npm ci
npm pack
npm install --global ./inspire-pi-gui-0.7.0.tgz
inspire
```

Use the tarball name printed by `npm pack`. Package from a separate checkout if the source Host is
running. Packaging keeps only the current assets, so older tabs can lose lazy-loaded assets.

To verify a release on the target platform, run `npm run release:verify` separately. It builds a
temporary tarball and tests the installed CLI, an external Pi session and terminal continuity
across Host restart. The [platform baseline](https://github.com/XWIlluDelu/pi-inspire/blob/main/docdoki/notes/platform-compatibility.md#verified-native-baseline)
records the checked versions.

## Updating Inspire

Finish active work and stop an older Host through its original launcher or service manager before
replacing its files. If the terminal daemon also needs an update, finish terminal work and stop it
through its original owner. Stop all old Hosts that share the same upload store.

Start the updated Host and reload the browser. Use the launcher link or Pair form if pairing is
needed. A stored generated token with an unsupported format requires explicit replacement and
browser re-pairing.

In a source checkout, `npm run build:web` publishes frontend changes while open pages keep working.
The next page load uses the new frontend. For Host changes, use `npm run inspire -- restart`;
it also rebuilds changed frontend inputs. Pi extension changes use
[`/reload`](pi-commands.md#compaction-and-reload).
