# SSH reverse connection

The `ssh-reverse` connection module exposes one local INSΠRE host through a server you control without binding INSΠRE to a public interface. INSΠRE and Pi remain on the local machine; the module owns only the local SSH tunnel.

```text
local INSΠRE host 127.0.0.1:4587
  → SSH reverse tunnel
  → server 127.0.0.1:<remote-port>
  → HTTPS reverse proxy
  → browser
```

The server-side HTTPS proxy is a user-controlled edge. It terminates HTTPS and can observe application traffic, so use a server and security policy you trust.

## Local configuration

Start the local host normally:

```bash
./inspire
```

Create the module configuration:

```bash
./inspire connection ssh-reverse init
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

The parser accepts only these fields; it never executes the configuration as shell code. It never accepts a remote bind address and always issues the equivalent of:

```bash
ssh -N -R 127.0.0.1:14587:127.0.0.1:4587 relay-user@relay-host
```

## Connection lifecycle

```bash
./inspire connection ssh-reverse start
./inspire connection ssh-reverse status
./inspire connection ssh-reverse restart
./inspire connection ssh-reverse stop
```

The connection commands manage only the verified SSH tunnel. They do not stop, replace, or otherwise own the local INSΠRE host. A tunnel start requires that the configured local loopback port is already listening.

`./inspire --ssh-reverse` is a shorthand for `./inspire connection ssh-reverse start`.

## Automatic recovery

Install the local host and tunnel user services:

```bash
./inspire stop
./inspire service install-host
./inspire connection ssh-reverse install-service
./inspire service enable-host
systemctl --user enable --now inspire-connection-ssh-reverse.service
```

The two services are independent: the host service owns the local INSΠRE process, while the tunnel service owns only SSH. The tunnel uses `Restart=always`, so it reconnects after a network interruption or server restart; the host uses `Restart=on-failure`. Because the tunnel runs with `BatchMode=yes`, an unattended service needs an SSH identity usable without an interactive password or passphrase prompt.

For recovery before a graphical login, enable the user manager to persist across logouts:

```bash
sudo loginctl enable-linger "$USER"
```

Stopping the connection service leaves `inspire-host.service` running:

```bash
systemctl --user stop inspire-connection-ssh-reverse.service
```

## Server-side minimum

The server needs an SSH account permitted to create the selected reverse listener and an HTTPS reverse proxy. Keep the SSH listener loopback-only; do not expose the tunnel port directly to the internet.

A minimal Caddy site is:

```caddyfile
inspire.example.com {
    encode zstd gzip

    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        X-Frame-Options "DENY"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
    }

    reverse_proxy 127.0.0.1:14587
}
```

Configure the site without an access log that retains request URLs. Caddy sets `X-Forwarded-Proto` for proxied requests by default; any substitute must overwrite that header. INSΠRE trusts it only when the immediate connection is loopback-local.

Use an SSH authorization policy that confines the key to the assigned `127.0.0.1:<remote-port>` reverse listener and disallows ordinary interactive use. Keep the public firewall limited to the HTTPS edge and the SSH service; the reverse listener itself remains local to the server.

## Browser pairing

A direct local launch URL may use the host token once and immediately removes it from browser history. A request received through the trusted HTTPS proxy always removes `?token=` without pairing, so a new remote browser must use the Pair form. The host then sends an origin-scoped `HttpOnly; SameSite=Strict; Secure` cookie, and WebSocket access uses that paired cookie rather than a query token.

The token remains a shared personal credential. Rotate it if it is exposed, and do not place it in server configuration, shell history, URLs, or logs.
