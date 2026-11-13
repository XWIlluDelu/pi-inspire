import { z } from "zod";
import {
  type ConfigurationControl,
  configurationField,
  fieldSchemas,
  nullableEdit,
  storedConfigurationField,
} from "./configuration-fields.js";

/** File configuration only; none of these values attest a Pi worker's loaded state. */
export type McpConfigScope = "user" | "project";
export const MCP_SERVER_NAME = /^[A-Za-z0-9_\x2D]+$/;
const MCP_CLIENT_REGISTRATIONS = ["auto", "dcr", "cimd"] as const;
export type McpClientRegistration = (typeof MCP_CLIENT_REGISTRATIONS)[number];
export const MCP_EXPOSURES = [
  "codemode",
  "deferred",
  "direct",
  "hidden",
] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

const textLength = 32_768;
const text = z.string().max(textLength);
type TextControl = Omit<ConfigurationControl, "label">;
const textControl = (label: string, options?: TextControl) => ({
  label,
  maxLength: textLength,
  ...options,
});
const oauthText = (label: string, options?: TextControl) =>
  configurationField(text, textControl(label, options));
export const mcpExposureSchema = z.enum(MCP_EXPOSURES);
export const mcpRegistrationSchema = z.enum(MCP_CLIENT_REGISTRATIONS);
const mapKey = z.string().min(1).max(256);
const stringMap = z.record(mapKey, text.nullable());
export const mcpPolicyFields = {
  enabled: nullableEdit(z.boolean()),
  exposure: nullableEdit(mcpExposureSchema),
  toolExposure: z.record(mapKey, mcpExposureSchema.nullable()).optional(),
};
export const mcpConnectionFields = {
  url: {
    schema: nullableEdit(text),
    stored: z.string().optional().catch(undefined),
    presence: (value: unknown) => typeof value === "string",
  },
  args: {
    schema: nullableEdit(z.array(text).max(256)),
    stored: z.array(z.string()).optional().catch(undefined),
    presence: (value: unknown) => (Array.isArray(value) ? value.length : 0),
  },
} as const;
export const mcpServerFields = {
  command: storedConfigurationField(
    z.string(),
    {
      label: "Program",
      placeholder: "npx",
      wide: true,
      maxLength: textLength,
      required: true,
    },
    text.min(1),
  ),
  cwd: storedConfigurationField(
    z.string(),
    textControl("Working directory", {
      placeholder: "Relative to the session directory",
      wide: true,
    }),
    text,
  ),
  description: storedConfigurationField(
    z.string(),
    textControl("Description", { wide: true }),
    text,
  ),
  timeout: storedConfigurationField(
    z.number(),
    {
      label: "Timeout (seconds)",
      type: "number",
      min: 0.001,
      step: "any",
      placeholder: "60",
    },
    z.number().positive(),
  ),
};
export const mcpPublicValuesSchema = z.object(
  fieldSchemas(mcpServerFields, "stored"),
);
export const mcpSecretMaps = {
  env: {
    label: "Environment variable",
    schema: stringMap.optional(),
    projection: "envKeys",
  },
  headers: {
    label: "Header",
    schema: stringMap.optional(),
    projection: "headerKeys",
  },
} as const;
const callbackPort = z.number().int().min(1).max(65535);
export const mcpOAuthFields = {
  clientId: oauthText("Client ID"),
  clientSecret: oauthText("Client secret", { type: "password" }),
  clientName: oauthText("Client name"),
  callbackUrl: oauthText("Callback URL"),
  callbackPort: configurationField(callbackPort, {
    label: "Callback port",
    type: "number",
    min: 1,
    max: 65535,
  }),
  scope: oauthText("OAuth scope"),
  authServerMetadataUrl: oauthText("Authorization server metadata URL"),
};
export const mcpConfigValuesSchema = z.strictObject({
  ...mcpPolicyFields,
  ...fieldSchemas(mcpServerFields, "schema"),
  ...fieldSchemas(mcpConnectionFields, "schema"),
  ...fieldSchemas(mcpSecretMaps, "schema"),
  oauth: z
    .strictObject({
      ...fieldSchemas(mcpOAuthFields, "schema"),
      clientRegistration: nullableEdit(mcpRegistrationSchema),
    })
    .optional(),
});
export type McpConfigValues = z.infer<typeof mcpConfigValuesSchema>;
/** Read only on explicit user request; never resolved or included in list snapshots. */
export const mcpConnectionValuesSchema = z.object(
  fieldSchemas(mcpConnectionFields, "stored"),
);
export type McpConnectionValues = z.infer<typeof mcpConnectionValuesSchema>;
export const mcpConnectionReadSchema = z.strictObject({
  scope: z.enum(["user", "project"]),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(256),
});
export type McpConnectionRead = z.infer<typeof mcpConnectionReadSchema>;
export type McpConfigEntry = z.infer<typeof mcpPublicValuesSchema> & {
  name: string;
  transport: "stdio" | "http" | null;
  /** Project policy override only; transport and credentials stay in the user file. */
  policyOnly: boolean;
  /** Null means inherited from user configuration for a policy-only entry. */
  enabled: boolean | null;
  exposure: McpExposure | null;
  /** List snapshots omit connection values; the editor can explicitly request URL/args. */
  urlConfigured: boolean;
  argumentCount: number;
  envKeys: string[];
  headerKeys: string[];
  oauthFields: string[];
  /** Registration policy is public; OAuth credentials remain write-only. */
  oauthClientRegistration?: McpClientRegistration;
  toolExposure: Record<string, McpExposure>;
  extraFieldCount: number;
};
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
export const mcpConfigEditSchema = mcpConnectionReadSchema.extend({
  operation: z.enum(["add", "update", "remove"]),
  values: mcpConfigValuesSchema.optional(),
});
export type McpConfigEdit = z.infer<typeof mcpConfigEditSchema>;
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
  if (port !== undefined && !callbackPort.safeParse(port).success)
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
    !mcpRegistrationSchema.safeParse(registration).success
  )
    return "OAuth client registration must be Auto, DCR or CIMD.";
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
