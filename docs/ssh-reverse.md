# SSH reverse connection

The optional `ssh-reverse` module connects a Linux Inspire Host to a server you control.
Pi, project files and terminals stay on the Host.

```text
local INSΠRE host 127.0.0.1:4587
  → SSH reverse tunnel
  → server 127.0.0.1:<remote-port>
  → HTTPS reverse proxy
  → browser
```

The server-side HTTPS proxy is a user-controlled edge. It terminates HTTPS and can observe application traffic, so use a server and security policy you trust.

The examples use the globally installed `inspire` command. In a source checkout, use `./inspire` instead.

## Before you start

First complete [local setup](../README.md#run-locally) and confirm that the Host works in a local
browser. For remote access, prepare:

- A Linux Host with `ssh` and `flock` (from `util-linux`). Automatic recovery uses a systemd user service.
- An SSH account on your server that permits the selected reverse listener. Verify the server's
  identity and save its trusted host key before starting the module: it uses
  `StrictHostKeyChecking=yes` and cannot accept a new key interactively.
- An SSH key or agent that can authenticate without a password or passphrase prompt. All tunnel
  starts use `BatchMode=yes`, including a manual start.
- A domain pointing to the server and an HTTPS reverse proxy, configured as described in
  [Server-side minimum](#server-side-minimum).

## Local configuration

With the Host running, create the module configuration from a second terminal:

```bash
inspire connection ssh-reverse init
```

For a source checkout, the command creates the ignored file `.inspire/connections/ssh-reverse.env`. An installed release uses `${XDG_CONFIG_HOME:-~/.config}/inspire/connections/ssh-reverse.env` instead. Both locations must remain private to the current user.

Set the remote SSH target and server loopback port:

```dotenv
INSPIRE_SSH_TARGET=relay-user@relay-host
INSPIRE_SSH_REMOTE_PORT=14587

# Optional; default is 4587.
# INSPIRE_SSH_LOCAL_PORT=4587

# Optional. When omitted, SSH uses the user's normal SSH config, agent, and keys.
# INSPIRE_SSH_IDENTITY_FILE=/absolute/path/to/private-key
```

The module reads these settings as data and fixes the server-side listener to loopback:

```bash
ssh -N -R 127.0.0.1:14587:127.0.0.1:4587 relay-user@relay-host
```

The initial connection times out after ten seconds. Three unanswered fifteen-second SSH probes
detect an interrupted connection. SSH uses its normal compression setting.

## Server-side minimum

Expose the reverse listener through HTTPS. A minimal Caddy site:

```caddyfile
inspire.example.com {
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        X-Frame-Options "DENY"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
    }

    # Compresses the phone-facing HTTP response. The INSΠRE Host separately
    # offers WebSocket per-message compression; verify negotiated extensions
    # in the browser trace rather than assuming the proxy preserved them.
    encode zstd gzip

    reverse_proxy 127.0.0.1:14587

    # Mark only Caddy handler failures, not a 5xx response returned by INSΠRE.
    handle_errors 502 503 504 {
        header X-Inspire-Edge "ssh-reverse"
        respond "{err.status_code} {err.status_text}"
    }
}
```

Avoid retaining request URLs in proxy logs. The proxy must preserve the public Host header and
overwrite `X-Forwarded-Proto` with `https`. Inspire trusts that header on loopback connections.

Use an SSH authorization policy that confines the key to the assigned `127.0.0.1:<remote-port>` reverse listener and disallows ordinary interactive use. Keep the reverse listener itself local to the server. Permit TCP 443 for HTTPS and, where the server firewall supports it, UDP 443 so Caddy can serve HTTP/3 on the phone-facing hop; `curl --http3-only -I https://inspire.example.com` can confirm that path when the installed curl build supports HTTP/3.

## Connection lifecycle

Start the tunnel, then inspect its status:

```bash
inspire connection ssh-reverse start
inspire connection ssh-reverse status
```

For later maintenance, use `inspire connection ssh-reverse restart` to reconnect or
`inspire connection ssh-reverse stop` to close the tunnel.

`start` requires a listener on the configured Host port. `status` checks that listener and the
managed SSH control connection. To test the public path, pair through the HTTPS address and
verify both an authenticated request and the WebSocket snapshot. The module log includes the
underlying SSH diagnostic for DNS, authentication, host-key and port-forwarding failures.

For a bounded client-side trace, browser developer tools can inspect `performance.getEntriesByType("measure").filter(({ name }) => name.startsWith("inspire:"))`. These process-local entries report bootstrap and WebSocket handshake duration (including whether `permessage-deflate` was actually negotiated), prompt-confirmation outcome, and ten-second stream frame/event/character aggregates; they contain no prompt or response text and are neither persisted nor uploaded.

`inspire --ssh-reverse` is a shorthand for `inspire connection ssh-reverse start`.

## Browser pairing

Open the public HTTPS address. In a private terminal on the Host, run `inspire token` and
paste the token into the browser's **Pair** form. Use the local launcher's one-use link only in a
local browser. The [pairing guide](host.md#browser-pairing) covers credentials, rotation and
the authority a paired browser has over files and terminals.

Project terminals use the same tunnel and reconnect to existing PTYs after an interruption.

## Automatic recovery

After testing browser access, you can move the Host and tunnel to user services. Finish active
Pi work first and run these commands from an external OS terminal. Stop the direct tunnel before
starting its service so both processes do not compete for the same remote port. The Host and
terminal effects of `inspire stop` are described in [Host lifecycle](host.md#lifecycle).

```bash
inspire connection ssh-reverse stop
inspire stop
inspire service install-host
inspire connection ssh-reverse install-service
inspire service enable-host
systemctl --user enable --now inspire-connection-ssh-reverse.service
```

The two services are independent: the host service owns the local INSΠRE process, while the tunnel
service owns only SSH. The tunnel uses `Restart=always`, so it reconnects after a network interruption
or server restart; the host uses `Restart=on-failure`. Ensure the SSH identity remains available to
the user service, including after logout or reboot; an agent unlocked only in an interactive shell
may be unavailable there.

There is one per-user SSH reverse unit. Lifecycle commands verify that it belongs to the current INSΠRE installation instead of controlling a stale or different checkout. Re-run `install-service` after moving or upgrading the installation; it restarts an active matching unit, but refuses to replace one owned by another active checkout.

For recovery before a graphical login, enable the user manager to persist across logouts:

```bash
sudo loginctl enable-linger "$USER"
```

Stopping the connection service leaves `inspire-host.service` running:

```bash
systemctl --user stop inspire-connection-ssh-reverse.service
```
