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
| Maintain or upgrade | [Host and terminal maintenance](#host-and-terminal-maintenance), [Linux user services](#linux-user-services), [Upgrading from older versions](#upgrading-from-older-versions) |
| Recover data or investigate errors | [Session recovery](#recover-a-deleted-session), [Uploaded files](#uploaded-file-retention-and-cleanup), [Diagnostics](#diagnostics) |
| Work from source or distribute a build | [Development checkout](#development-checkout), [Build and install a package](#build-and-install-a-package) |

## Run and reopen

Commands in this guide use the globally installed `inspire` entry. From a source checkout, use
`npm run inspire -- <arguments>` (or `./inspire <arguments>` on Linux/macOS). With restricted
Windows PowerShell, use the [batch shims from the README](../README.md#run-locally).

Running the launcher again reopens the matching Host. `inspire status` checks that instance and
prints a fresh local pairing link; it does not start a stopped Host. A direct launch stays attached
to its terminal, so keep that terminal open, or use [Linux user services](#linux-user-services).
Closing a browser page does not stop the Host.

Set overrides in the environment that launches the Host:

| Variable | Meaning |
| --- | --- |
| `INSPIRE_HOST` | Loopback address: `127.0.0.1` (default), `::1`, or `localhost`. Remote access goes through an HTTPS ingress such as reverse SSH. |
| `INSPIRE_PORT` | TCP port, default `4587`. Use a separate port for another Host or a development instance. |
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

The page follows Inspire's theme. Android's gesture/navigation area belongs to the browser and OS:
the manifest sets no theme color and the page supplies a dynamic hint, which does not guarantee
that the system bar matches. The manifest background stays neutral light for startup.

An Android WebAPK can keep older installed colors after a manifest update. Open the installed app
so Chrome checks for an update, then let the background update finish (Chrome usually waits until
the app is closed and the device has Wi-Fi and power; see
[Chrome's manifest update process](https://web.dev/articles/manifest-updates#updates_on_chrome_for_android)).
`chrome://webapks` shows the installed metadata and offers **Update**; a current package has no
fixed **Theme color**. Keep the same app URL and installation; clearing site data, pairing again or
reinstalling does not speed up the update. To tell a browser issue from an installed-app issue,
compare the same page and theme in an ordinary Chrome tab.

## Lifecycle

| Command | Effect |
| --- | --- |
| `inspire` | Start or reopen the matching instance. |
| `inspire status` | Check the managed Host and print a fresh local pairing link. |
| `inspire token` | Print the verified Host token for manual pairing; keep this output private. |
| `inspire restart` | Prepare the next build/runtime, then restart as **Restart Host** does: the Host and its own Pi workers restart, and taken-over Pi reload their settings. Project terminals keep running. |
| `inspire restart --host-only` | Restart Inspire while every Pi process, including Inspire's workers, keeps running with its work. |
| `inspire restart --all` | Restart this installation's Linux Host and terminal services, closing project terminals in the installed terminal service. |
| `inspire stop` | Stop the Host and its installed terminal service. A direct-launch terminal daemon keeps running. |
| `inspire terminal status` | Inspect the matching terminal daemon without creating one. |
| `inspire terminal stop` | Stop that daemon; running terminals require `--force`. |
| `inspire terminal restart` | Replace that daemon; saved tabs return as exited. Running terminals require `--force`. |

## Task notifications

In **Settings → Behavior → Task alerts**, choose **System notification** on each device that should
receive alerts, then click **Enable notifications**, allow the browser permission, and check for
**Background notifications enabled**. Choosing **System notification** alone does not finish setup.
**While Inspire is open** means background delivery is unavailable, though alerts still work while
the page is open. Settings explains setup failures. Reopening Inspire or Settings retries an
interrupted registration without asking for permission again; an expired subscription needs
**Enable notifications** again.

Completions and errors notify you when you are away from the conversation; a confirmed Stop does
not. **Notification grouping** chooses **Session** (default) or **Project** on this device, and a
newer result replaces the group's older notification. Project grouping shows the session name for
one conversation or **n sessions** for several; repeated runs in one session count once.
Dismissing or clicking a notification resets its count, and viewing one session leaves its unread
project peers in place. Changing grouping clears existing notifications without affecting
permission or enrollment. **Mark tab** applies only to open pages.

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

Alert choices are device-local: a new browser starts Off, and existing paired browsers keep their
choice but must enable background delivery explicitly. Reset preferences affects only the current
device. Pending alerts expire after 15 minutes. Notification state, including VAPID and
subscription secrets, is stored beside the preferences file as
`<preferences-path>.notifications-<authority-namespace>.json`; do not publish it.

A terminal Pi reports completion, failure and cancellation through
[attach-control](extensions.md#share-sessions-with-terminal-pi). After updating it, run `/reload` in
that Pi; a Host-only restart does not reload it.

## Host and terminal maintenance

**Settings → System → Host** offers two restart actions.

| Action | Effect |
| --- | --- |
| **Restart Host** | Restarts Inspire and its own Pi workers, and reloads every terminal Pi it has taken over so they apply current settings. Use it after changing settings or extensions. |
| **Restart all** | Like Restart Host, and also restarts the installed Linux terminal service, closing its project terminals. |

Restart Host and Restart all check for unfinished work first. If work is running, they offer a
separately confirmed **Stop work and restart**, which interrupts that work and discards Pending
input. Idle workers do not block a restart. After a restart, a session a terminal Pi is running
opens read-only with **Take over**, and the rest continue directly. After a disconnect, the browser
keeps tracking the submitted restart without sending another.

Run `inspire restart --host-only` to restart Inspire while every Pi process, including Inspire's
own workers, keeps its running work and loaded settings. Inspire finds its former workers
read-only with **Take over**. Taking over also restores their pending browser questions.

The browser drops its tracking once it reconnects to the new Host or sees the request rejected.
Uncertain requests keep their identity for status checks and explicit retries. **Recheck status**
reads the Host even when browser recovery storage is unavailable. Only an invalid saved record
offers **Reset restart recovery…** (with confirmation), which removes browser tracking without
sending or cancelling a restart. A restart already pending on the Host blocks a new one.

Page restart works on Windows, macOS and Linux for a Host started through `inspire` or
`npm run inspire`, and for the installed Linux service. It keeps the launcher, environment, instance
configuration and pairing, and opens no new browser window. **Restart Host** also keeps project
terminals running. If preparation fails, the Host keeps running. A failed Pi cleanup prevents Host
replacement. A Host started from an internal server entry point must be restarted by its operator.

Restarts leave connection services running. `inspire restart --all` requires the installed Linux
services and an external OS terminal, since the project terminal running the command could close
before it shows the result. Settings shows the availability of both restart scopes.

CLI restart requires the running Host to confirm the requested scope over authenticated HTTP
before it stops the process. If the listener is down, use `inspire stop` with the running Host's
port and state-path overrides, then start Inspire again after shutdown completes. Stopping an
installed service also ends its project terminals.

### Terminal-service maintenance

**Restart Host** and `inspire restart --host-only` keep the existing terminal daemon. Manage it from an
**external terminal**, not from an Inspire project terminal (stopping the daemon would end the
command; it refuses to run there, while `status` is allowed):

```sh
inspire terminal status
inspire terminal restart
# Confirm ending every live project terminal in this daemon:
inspire terminal restart --force
# Or stop it without a replacement:
inspire terminal stop --force
```

Reuse the Host's `INSPIRE_HOST`, `INSPIRE_PORT`, `INSPIRE_TERMINAL_DAEMON_ADDRESS`,
`INSPIRE_TERMINAL_TOKEN_PATH` and `INSPIRE_TERMINAL_STATE_PATH` overrides. These commands leave the
Host and Pi workers running. `--force` confirms ending live terminals but does not bypass
authentication; saved tabs return as exited without rerunning commands.

If PTY cleanup fails or is unconfirmed, replacement is refused and terminal writes are blocked;
status and lifecycle controls stay available. A missing endpoint means nothing is listening, not
that the process has exited. The installed Linux terminal unit keeps systemd ownership;
[terminal ownership](https://github.com/XWIlluDelu/pi-inspire/blob/main/docdoki/specs/terminal.md#process-ownership)
defines the handoff.

### Connection recovery and upgrades

A compatible terminal service reconnects without a Host restart. If the first connection fails,
later terminal requests retry on demand; there is no background restart loop and no replay of
terminal input or controls. Missing optional maintenance controls do not disable a compatible
connection, and a failed check alone does not mean the protocols differ: inspect
`inspire terminal status` and the owning service first. The error card keeps the connection detail
for copying.

After enabling the Linux units, a compatible terminal daemon retained from a direct launch keeps
serving the Host. **Restart all** affects the installed terminal service. The retained daemon keeps
running, and the installed daemon can exit with code 78 when it finds that owner. To move terminal
ownership to the installed service, finish terminal work, run `inspire terminal stop` from an
external OS terminal, then run `systemctl --user start inspire-terminal.service`. See
[Older terminal daemons](#older-terminal-daemons) for daemons without authenticated lifecycle controls.

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

A projection-conflict banner shows an incident ID that matches a log record. Logs contain operation,
process, timing and persistence metadata, never prompts, tool output, extension payloads,
credentials or raw child stderr. Files are private (`0700`/`0600` on POSIX, the user-profile ACL on
Windows). Rotation keeps five 5 MiB files. `INSPIRE_LOG_PATH` selects another file inside an
existing private directory.

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

Inspire packages the browser client and compiled Host as a standalone npm CLI. The installed
application uses an external Pi; the Pi development dependency is only for compatibility checks.

```bash
npm ci
npm run release:verify
npm pack
npm install --global ./inspire-pi-gui-0.7.0.tgz
inspire
```

Use the tarball name printed by `npm pack`; `prepack` builds the release. `release:verify` checks the
tarball and a production-only installation, including the CLI and an external Pi SDK/RPC session
without a model call. CI exercises the packaged lifecycle on Linux, macOS and Windows;
[platform evidence](https://github.com/XWIlluDelu/pi-inspire/blob/main/docdoki/notes/platform-compatibility.md#verified-native-baseline)
records the checked versions.

In an updated source checkout, `npm run inspire -- restart` rebuilds changed client inputs before
replacing a Host that supports signed restart preparation. For a Host from before that change,
follow the [one-time upgrade steps](#older-hosts-and-restart-preparation). Pi extension changes
need only [`/reload`](pi-commands.md#compaction-and-reload).

## Upgrading from older versions

These steps apply once, when upgrading an installation that predates the named change.

### Migration from cookie pairing

Generated cookie-era tokens rotate once on the next Host start; reopen the launcher URL or pair with
the new token. Visiting the Host expires its old pairing cookies without touching other site data;
cookies no longer authenticate.

**If you set `INSPIRE_TOKEN` yourself and paired a browser with cookies, rotate that token before
relying on per-port isolation.** Inspire cannot replace an operator-supplied secret, and an old
cookie may contain a copy of it that still works as an explicit bearer. Replace the value in your
secret configuration and restart the Host. Old browser bundles must reload and pair again.

### Older Hosts and restart preparation

An older Host such as the v0.6.5 release can authenticate readiness without supporting signed
restart preparation. After updating that installation in place, open **Settings → System → Host**
on the still-running Host and choose **Restart Host**. The running Host prepares and starts the
replacement through its existing launcher or service while keeping project terminals running.

If page restart is unavailable, stop the old Host through its launcher or service manager and
start the updated installation once shutdown completes. For legacy Linux instances, `inspire stop`
can use the verified process fallback. On Windows and macOS, a Host without authenticated shutdown
must be stopped through its service manager or inspected process controls. See the
[ownership contract](https://github.com/XWIlluDelu/pi-inspire/blob/main/docdoki/specs/host-lifecycle.md#instances-and-local-control).

### Older terminal daemons

Terminal units that set `NODE_ENV=production` need reinstallation when terminal processes can end.
Run these commands from an external OS terminal.

```bash
inspire service install-host
inspire restart --all
```

The authenticated terminal IPC needs a terminal-service restart, not only a Host restart; finish
terminal work first. A Host never kills or silently replaces a still-listening old daemon. New
daemons use a fresh private TLS secret at `<terminal-token-path>.tls-v3`, keeping the configured
token-path stem compatible with existing service arguments.

Daemons from before lifecycle controls need a one-time manual upgrade through their owner. For the
installed Linux terminal service, use **System → Host → Restart all** after finishing terminal work.
For older direct launches, stop the Host, find the current user's exact terminal daemon and stop
its process tree once:

- macOS: inspect `ps -axo user,pid,command` (the title may be `inspire-terminal`) and use `lsof` to
  confirm its socket and working directory, then `kill -TERM <pid>`.
- Windows: inspect Process ID and CommandLine in Task Manager or `Get-CimInstance Win32_Process`,
  then `taskkill /PID <pid> /T /F` for the verified tree.

Do not stop unrelated Node processes or trust a listener's claimed PID. Later upgrades use
`inspire terminal` commands.

### Upload storage

Older session-directory registries, continuity markers and volume anchors are no longer used and
need no migration. Hosts that share an upload store must all be upgraded to get the durable-asset
policy, because older versions still collect delivered uploads automatically; leave the legacy
metadata in place until they are stopped or upgraded.
