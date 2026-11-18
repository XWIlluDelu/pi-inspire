import { join } from "node:path";
import { isJsonRecord, jsonRecord } from "../shared/json-record.js";
import {
  MCP_SERVER_NAME,
  type McpConfigEdit,
  type McpConfigEntry,
  type McpConfigScope,
  type McpConfigSnapshot,
  type McpConfigValues,
  type McpConnectionRead,
  type McpConnectionValues,
  mcpConfigValuesSchema,
  mcpConnectionFields,
  mcpConnectionValuesSchema,
  mcpExposureSchema,
  mcpOAuthError,
  mcpPolicyFields,
  mcpPublicValuesSchema,
  mcpRegistrationSchema,
  mcpSecretMaps,
} from "../shared/mcp.js";
import {
  applyConfigurationPatch,
  configurationFileTarget,
  type ConfigurationAuthority,
  editConfigurationDocument,
  readConfigurationDocument,
} from "./configuration-file.js";
import { filesystemRelativePath } from "./filesystem-containment.js";
import { resolveProjectDirectory } from "./paths.js";
import { getAgentDir } from "./pi-runtime.js";
import { requestError } from "./request-error.js";

type JsonObject = Record<string, unknown>;
const normalizeExposure = (value: unknown) =>
  value === "codemode-deferred" ? "codemode" : value;
const parseExposure = (value: unknown) =>
  mcpExposureSchema.safeParse(normalizeExposure(value)).data;
const strings = (value: unknown) =>
  isJsonRecord(value) ? Object.keys(value) : [];
const configFields = mcpConfigValuesSchema.shape;
const hasOnlyPolicy = (value: JsonObject) =>
  Object.keys(value).every((key) => Object.hasOwn(mcpPolicyFields, key));
const isPolicyOnly = (value: unknown, scope: McpConfigScope) =>
  scope === "project" && isJsonRecord(value) && hasOnlyPolicy(value);
const nameInPi = (name: string) => name.replaceAll("-", "_");
const userOnlyAuth =
  "Pi provider authentication is only allowed in user MCP configuration";
const secureAuth =
  "Pi provider authentication requires HTTPS except on loopback";

function transportOf(value: JsonObject) {
  return typeof value.url === "string" &&
    [undefined, "http", "streamable-http"].includes(value.type as string)
    ? "http"
    : typeof value.command === "string" &&
        [undefined, "stdio"].includes(value.type as string)
      ? "stdio"
      : null;
}

function projectEntry(
  name: string,
  raw: unknown,
  scope: McpConfigScope,
): McpConfigEntry {
  const value = isJsonRecord(raw) ? raw : {};
  const policyOnly = isPolicyOnly(raw, scope);
  const registration = isJsonRecord(value.oauth)
    ? mcpRegistrationSchema.safeParse(value.oauth.clientRegistration).data
    : undefined;
  return {
    name,
    transport: transportOf(value),
    policyOnly,
    ...mcpPublicValuesSchema.parse(value),
    enabled:
      typeof value.enabled === "boolean"
        ? value.enabled
        : policyOnly
          ? null
          : true,
    exposure:
      parseExposure(value.exposure) ?? (policyOnly ? null : "codemode"),
    urlConfigured: mcpConnectionFields.url.presence(value.url),
    argumentCount: mcpConnectionFields.args.presence(value.args),
    [mcpSecretMaps.env.projection]: strings(value.env),
    [mcpSecretMaps.headers.projection]: strings(value.headers),
    oauthFields: strings(value.oauth),
    ...(registration ? { oauthClientRegistration: registration } : {}),
    toolExposure: Object.fromEntries(
      isJsonRecord(value.toolExposure)
        ? Object.entries(value.toolExposure).flatMap(([key, val]) => {
            const mode = parseExposure(val);
            return mode ? [[key, mode]] : [];
          })
        : [],
    ),
    extraFieldCount: Object.keys(value).filter(
      (key) => key !== "type" && !Object.hasOwn(configFields, key),
    ).length,
  };
}
const mcpDocument = {
  invalid: "Repair the invalid mcp.json object before editing it",
  preserveIndent: true,
};
function serversOf({ mcpServers = {} }: JsonObject): JsonObject {
  if (isJsonRecord(mcpServers)) return mcpServers;
  throw requestError(mcpDocument.invalid, 409);
}

async function readServers(
  file: ConfigurationAuthority,
  expected?: Parameters<typeof readConfigurationDocument>[2],
) {
  const { value, revision, error } = await readConfigurationDocument(
    file,
    mcpDocument,
    expected,
  );
  if (error) throw requestError(error, 409);
  return { servers: serversOf(value), revision };
}

function mergeValues(current: JsonObject, values: McpConfigValues): JsonObject {
  const patch: JsonObject = { ...values };
  for (const key of ["env", "headers", "oauth"] as const) {
    if (values[key])
      patch[key] = applyConfigurationPatch(
        jsonRecord(current[key]) ?? {},
        values[key],
      );
  }
  if (values.toolExposure)
    patch.toolExposure = applyConfigurationPatch({}, values.toolExposure);
  return applyConfigurationPatch(current, patch);
}
function validate(value: JsonObject, scope: McpConfigScope): void {
  const { command, url, auth, oauth, ...fields } = value;
  const transport = transportOf(value);
  if (command !== undefined && url !== undefined)
    throw requestError(
      "Choose either a stdio program or an HTTP URL, not both",
      400,
    );
  if (!transport)
    throw requestError("Choose a stdio program or a streamable HTTP URL", 400);
  if (transport === "stdio" && !(command as string).trim())
    throw requestError("A stdio program is required", 400);
  if (transport === "http") {
    let target: URL;
    try {
      target = new URL(url as string);
    } catch {
      throw requestError("Enter a valid HTTP or HTTPS URL", 400);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:")
      throw requestError("Enter a valid HTTP or HTTPS URL", 400);
    if (auth !== undefined && scope === "project")
      throw requestError(userOnlyAuth, 400);
    if (
      auth !== undefined &&
      target.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
    )
      throw requestError(secureAuth, 400);
  }
  // Validate supported fields without returning the submitted or stored secret in errors.
  const known = Object.fromEntries(
    Object.entries(fields).filter(([key]) => Object.hasOwn(configFields, key)),
  );
  if (Object.hasOwn(known, "exposure"))
    known.exposure = normalizeExposure(known.exposure);
  if (isJsonRecord(known.toolExposure))
    known.toolExposure = Object.fromEntries(
      Object.entries(known.toolExposure).map(([key, mode]) => [
        key,
        normalizeExposure(mode),
      ]),
    );
  const oauthError = mcpOAuthError(oauth);
  if (oauthError) throw requestError(oauthError, 400);
  if (!mcpConfigValuesSchema.safeParse({ command, url, ...known }).success)
    throw requestError(
      "MCP configuration has invalid field values; check the server configuration",
      400,
    );
}

export class McpConfigService {
  constructor(private readonly agentDir = getAgentDir()) {}
  private authority(cwd: string | null, scope: McpConfigScope) {
    if (scope === "user") return { path: join(this.agentDir, "mcp.json") };
    if (!cwd)
      throw requestError(
        "Select a project before editing project MCP configuration",
        409,
      );
    const path = join(cwd, ".pi", "mcp.json");
    return {
      path,
      resolveTarget: async () => {
        const project = await resolveProjectDirectory(cwd);
        const target = await configurationFileTarget(path);
        if ((await filesystemRelativePath(project, target)) === null)
          throw requestError(
            "Project mcp.json points outside this project; edit that file directly",
            409,
          );
        return target;
      },
    };
  }
  private async readFile(cwd: string | null, scope: McpConfigScope) {
    const file = this.authority(cwd, scope);
    const identified = { scope, path: file.path };
    try {
      const { servers, revision } = await readServers(file);
      return {
        ...identified,
        revision,
        entries: Object.entries(servers).map(([name, record]) =>
          projectEntry(name, record, scope),
        ),
      };
    } catch (error) {
      return {
        ...identified,
        revision: "",
        entries: [],
        error:
          error instanceof Error
            ? error.message
            : "MCP configuration is unavailable",
      };
    }
  }

  async read(cwd: string | null): Promise<McpConfigSnapshot> {
    const scopes: McpConfigScope[] =
      cwd === null ? ["user"] : ["user", "project"];
    return {
      cwd,
      files: await Promise.all(
        scopes.map((scope) => this.readFile(cwd, scope)),
      ),
    };
  }
  async readConnection(
    cwd: string | null,
    request: McpConnectionRead,
  ): Promise<McpConnectionValues> {
    const { servers } = await readServers(this.authority(cwd, request.scope), {
      revision: request.revision,
      stale:
        "MCP configuration changed elsewhere. Refresh files before viewing saved values.",
    });
    const entry = Object.hasOwn(servers, request.name)
      ? servers[request.name]
      : undefined;
    if (!isJsonRecord(entry))
      throw requestError(
        "That server is no longer available in this file",
        409,
      );
    // Return only literal connection values, never execute hooks or include credentials
    // from unrelated fields. URL/arguments themselves may contain user-saved secrets.
    return mcpConnectionValuesSchema.parse(entry);
  }

  async save(cwd: string | null, edit: McpConfigEdit): Promise<void> {
    const { name, operation, scope, revision, values = {} } = edit;
    const user = this.authority(cwd, "user");
    const adding = operation === "add";
    await editConfigurationDocument(
      {
        ...this.authority(cwd, scope),
        expectedRevision: revision,
        // Add shares the user authority so concurrent user/project additions
        // cannot each validate against the other file's old namespace.
        alsoLock: scope === "project" && adding ? [user] : [],
      },
      mcpDocument,
      async (document) => {
        const servers = serversOf(document);
        const exists = Object.hasOwn(servers, name);
        if (adding === exists)
          throw requestError(
            exists
              ? "That server already exists in this file"
              : "That server no longer exists in this file",
            409,
          );
        const update = (value: JsonObject | null) => ({
          ...document,
          mcpServers: applyConfigurationPatch(servers, { [name]: value }),
        });
        if (operation === "remove") return update(null);
        const current = adding ? {} : servers[name];
        if (!isJsonRecord(current))
          throw requestError(
            "Remove the invalid server entry before adding it again",
            409,
          );
        const value = mergeValues(current, values);
        if (isPolicyOnly(adding ? value : current, scope)) {
          if (!hasOnlyPolicy(values))
            throw requestError(
              "Project policy overrides can only edit enabled, exposure and toolExposure",
              400,
            );
          const { servers: records } = await readServers(user);
          const base = Object.hasOwn(records, name) ? records[name] : undefined;
          if (!isJsonRecord(base))
            throw requestError(
              "Project policy override needs a same-name user server",
              409,
            );
          validate({ ...base, ...value }, "user");
        } else {
          validate(value, scope);
        }
        if (!MCP_SERVER_NAME.test(name))
          throw requestError(
            "Use letters, digits, underscores or hyphens for the server name",
            400,
          );
        const names = Object.keys(servers);
        if (adding && cwd !== null) {
          const other = scope === "user" ? "project" : "user";
          names.push(
            ...(await this.readFile(cwd, other)).entries.map(
              ({ name }) => name,
            ),
          );
        }
        if (
          names.some(
            (other) => other !== name && nameInPi(other) === nameInPi(name),
          )
        )
          throw requestError(
            "Server names differing only in hyphens and underscores conflict in Pi",
            409,
          );
        return update(value);
      },
    );
  }
}
