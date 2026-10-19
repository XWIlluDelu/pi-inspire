import { Buffer } from "node:buffer";
import {
  type ConnectionOptions,
  connect,
  type TLSSocket,
  type TlsOptions,
} from "node:tls";
import { readAccessToken, resolveAccessToken } from "./access-token.js";

// Certificate-free, mutually authenticated TLS over a local socket/pipe. The
// per-user daemon token is the PSK: it never crosses the wire, and terminal
// input/output remains confidential even through a relaying local endpoint.
// TLS 1.2 PSK with AES-GCM is supported by Node's bundled OpenSSL on every Host OS.
const TLS_OPTIONS = {
  ciphers: "PSK-AES256-GCM-SHA384",
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
} as const;
const PSK_IDENTITY = "inspire-terminal-v3";

/** Do not reuse a key that an older client may have sent in plaintext.
 * Keeping the configured path as a stem also preserves installed unit args. */
export function terminalDaemonSecretPath(tokenPath: string): string {
  return tokenPath + ".tls-v3";
}

export function readTerminalDaemonSecret(tokenPath: string): Promise<string> {
  return readAccessToken(terminalDaemonSecretPath(tokenPath));
}

export function resolveTerminalDaemonSecret(
  tokenPath: string,
): Promise<string> {
  return resolveAccessToken(undefined, terminalDaemonSecretPath(tokenPath));
}

export function terminalDaemonTlsOptions(token: string): TlsOptions {
  return {
    ...TLS_OPTIONS,
    handshakeTimeout: 5_000,
    pskCallback: (_socket, identity) =>
      identity === PSK_IDENTITY ? Buffer.from(token, "utf8") : null,
  };
}

export function connectTerminalDaemon(
  address: string,
  token: string,
): TLSSocket {
  const options: ConnectionOptions = {
    ...TLS_OPTIONS,
    path: address,
    pskCallback: () => ({
      identity: PSK_IDENTITY,
      psk: Buffer.from(token, "utf8"),
    }),
    // PSK cipher suites authenticate possession of the secret, not an X.509
    // certificate. No certificate-based cipher or TLS version can negotiate.
    rejectUnauthorized: false,
  };
  return connect(options);
}
