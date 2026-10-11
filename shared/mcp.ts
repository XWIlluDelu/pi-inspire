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
  cwd: string;
  files: McpConfigFile[];
}
export interface McpConfigEdit {
  scope: McpConfigScope;
  revision: string;
  name: string;
  operation: "add" | "update" | "remove";
  values?: McpConfigValues;
}
export interface McpConfigWriteResult {
  saved: true;
  snapshot?: McpConfigSnapshot;
  warning?: string;
}
