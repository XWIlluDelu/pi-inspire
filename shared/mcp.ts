/** File configuration only; none of these values attest a Pi worker's loaded state. */
export type McpConfigScope = "user" | "project";
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
export const MCP_EXPOSURES: McpExposure[] = [
  "codemode",
  "deferred",
  "direct",
  "hidden",
];

export interface McpConfigValues {
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  url?: string | null;
  description?: string | null;
  timeout?: number | null;
  enabled?: boolean | null;
  exposure?: McpExposure | null;
  env?: Record<string, string | null>;
  headers?: Record<string, string | null>;
  toolExposure?: Record<string, McpExposure | null>;
  oauth?: {
    clientRegistration?: "dcr" | "cimd" | null;
    clientId?: string | null;
    clientSecret?: string | null;
    callbackPort?: number | null;
    callbackUrl?: string | null;
    scope?: string | null;
    clientName?: string | null;
    authServerMetadataUrl?: string | null;
  };
}
export interface McpConfigEntry {
  name: string;
  transport: "stdio" | "http" | null;
  /** Project policy override only; transport and credentials stay in the user file. */
  policyOnly: boolean;
  command?: string;
  cwd?: string;
  description?: string;
  timeout?: number;
  /** Null means inherited from user configuration for a policy-only entry. */
  enabled: boolean | null;
  exposure: McpExposure | null;
  /** Stored URL, arguments and credential-bearing values never cross to the browser. */
  urlConfigured: boolean;
  argumentCount: number;
  envKeys: string[];
  headerKeys: string[];
  oauthFields: string[];
  /** Registration policy is public; OAuth credentials remain write-only. */
  oauthClientRegistration?: "dcr" | "cimd";
  toolExposure: Record<string, McpExposure>;
  extraFieldCount: number;
}
export interface McpConfigFile {
  scope: McpConfigScope;
  path: string;
  revision: string;
  error?: string;
  entries: McpConfigEntry[];
}
export interface McpConfigSnapshot {
  /** Null when no project is selected; user configuration remains available. */
  cwd: string | null;
  files: McpConfigFile[];
}
export interface McpConfigEdit {
  scope: McpConfigScope;
  revision: string;
  name: string;
  operation: "add" | "update" | "remove";
  values?: McpConfigValues;
}
/** Pi's documented OAuth contract, applied to the merged object, not just an edit.
 * Unknown extension fields survive; diagnostics never include protected values. */
export function mcpOAuthError(value: unknown): string | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "OAuth configuration must be an object.";
  const oauth = value as Record<string, unknown>;
  for (const key of ["clientId", "clientSecret", "scope"])
    if (oauth[key] !== undefined && typeof oauth[key] !== "string")
      return `OAuth ${key} must be a string.`;
  if (
    oauth.clientName !== undefined &&
    (typeof oauth.clientName !== "string" || !oauth.clientName.trim())
  )
    return "OAuth client name must not be blank.";
  const port = oauth.callbackPort;
  if (
    port !== undefined &&
    (typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535)
  )
    return "OAuth callback port must be an integer from 1 to 65535.";
  const parseUrl = (value: unknown) =>
    typeof value === "string" && URL.canParse(value) ? new URL(value) : null;
  const loopback = (url: URL) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const callback = parseUrl(oauth.callbackUrl);
  if (
    oauth.callbackUrl !== undefined &&
    (!callback ||
      callback.protocol !== "http:" ||
      !loopback(callback) ||
      callback.search ||
      callback.hash ||
      (callback.port && port !== undefined && Number(callback.port) !== port))
  )
    return "OAuth callback must use loopback HTTP and match the callback port.";
  const registration = oauth.clientRegistration;
  if (
    registration !== undefined &&
    registration !== "dcr" &&
    registration !== "cimd"
  )
    return "OAuth client registration must be DCR or CIMD.";
  if (registration === "cimd") {
    if (oauth.clientId !== undefined || oauth.clientName !== undefined)
      return "CIMD cannot use a client ID or client name. Remove those values or change the registration method.";
    if (
      callback &&
      (callback.hostname === "[::1]" || callback.pathname !== "/callback")
    )
      return "CIMD callback must use localhost or 127.0.0.1 with the path /callback.";
  }
  if (oauth.authServerMetadataUrl !== undefined) {
    const url = parseUrl(oauth.authServerMetadataUrl);
    if (
      !url ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && loopback(url)))
    )
      return "OAuth metadata must use HTTPS, or HTTP on loopback.";
  }
}

export interface McpConfigWriteResult {
  saved: true;
  snapshot?: McpConfigSnapshot;
  warning?: string;
}
