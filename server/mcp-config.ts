import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import {
  MCP_EXPOSURES,
  type McpConfigEdit,
  type McpConfigEntry,
  type McpConfigScope,
  type McpConfigSnapshot,
  type McpConfigValues,
  type McpConnectionRead,
  type McpConnectionValues,
  mcpOAuthError,
} from "../shared/mcp.js";
import { configurationEditLockPaths } from "./configuration-edit-locks.js";
import { filesystemRelativePath } from "./filesystem-containment.js";
import { resolveProjectDirectory } from "./paths.js";
import { getAgentDir } from "./pi-runtime.js";
import { requestError } from "./request-error.js";

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = z.string().max(32_768);
const exposure = z.enum(MCP_EXPOSURES);
const changes = <T extends z.ZodType>(schema: T) =>
  schema.nullable().optional();
const stringMap = z.record(z.string().min(1).max(256), text.nullable());
const oauthSchema = z
  .object({
    clientRegistration: changes(z.enum(["dcr", "cimd"])),
    clientId: changes(text),
    clientSecret: changes(text),
    callbackPort: changes(z.number().int().min(1).max(65535)),
    callbackUrl: changes(text),
    scope: changes(text),
    clientName: changes(text),
    authServerMetadataUrl: changes(text),
  })
  .strict();
const valuesSchema = z
  .object({
    command: changes(text.min(1)),
    args: changes(z.array(text).max(256)),
    cwd: changes(text),
    url: changes(text),
    description: changes(text),
    timeout: changes(z.number().positive()),
    enabled: changes(z.boolean()),
    exposure: changes(exposure),
    env: stringMap.optional(),
    headers: stringMap.optional(),
    toolExposure: z
      .record(z.string().min(1).max(256), exposure.nullable())
      .optional(),
    oauth: oauthSchema.optional(),
  })
  .strict();
export const mcpConnectionReadSchema = z
  .object({
    scope: z.enum(["user", "project"]),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(256),
  })
  .strict();
export const mcpConfigEditSchema = mcpConnectionReadSchema.extend({
  operation: z.enum(["add", "update", "remove"]),
  values: valuesSchema.optional(),
});
const normalExposure = (value: unknown) =>
  value === "codemode-deferred" ? "codemode" : exposure.safeParse(value).data;
const strings = (value: unknown) => (isObject(value) ? Object.keys(value) : []);
const fieldNames = new Set([
  "type",
  "command",
  "args",
  "cwd",
  "url",
  "description",
  "timeout",
  "enabled",
  "exposure",
  "env",
  "headers",
  "toolExposure",
  "oauth",
]);

const policyFields = new Set(["enabled", "exposure", "toolExposure"]);
const isPolicyOnly = (value: unknown, scope: McpConfigScope) =>
  scope === "project" &&
  isObject(value) &&
  Object.keys(value).every((key) => policyFields.has(key));

function projectEntry(
  name: string,
  raw: unknown,
  scope: McpConfigScope,
): McpConfigEntry {
  const value = isObject(raw) ? raw : {};
  const transport =
    typeof value.url === "string" &&
    [undefined, "http", "streamable-http"].includes(value.type as string)
      ? "http"
      : typeof value.command === "string" &&
          [undefined, "stdio"].includes(value.type as string)
        ? "stdio"
        : null;
  const policyOnly = isPolicyOnly(raw, scope);
  return {
    name,
    transport,
    policyOnly,
    ...(typeof value.command === "string" ? { command: value.command } : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    ...(typeof value.timeout === "number" ? { timeout: value.timeout } : {}),
    enabled:
      typeof value.enabled === "boolean"
        ? value.enabled
        : policyOnly
          ? null
          : true,
    exposure:
      normalExposure(value.exposure) ?? (policyOnly ? null : "codemode"),
    urlConfigured: typeof value.url === "string",
    argumentCount: Array.isArray(value.args) ? value.args.length : 0,
    envKeys: strings(value.env),
    headerKeys: strings(value.headers),
    oauthFields: strings(value.oauth),
    ...(isObject(value.oauth) &&
    ["dcr", "cimd"].includes(value.oauth.clientRegistration as string)
      ? {
          oauthClientRegistration: value.oauth.clientRegistration as
            | "dcr"
            | "cimd",
        }
      : {}),
    toolExposure: Object.fromEntries(
      isObject(value.toolExposure)
        ? Object.entries(value.toolExposure).flatMap(([key, val]) => {
            const mode = normalExposure(val);
            return mode ? [[key, mode]] : [];
          })
        : [],
    ),
    extraFieldCount: Object.keys(value).filter((key) => !fieldNames.has(key))
      .length,
  };
}
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw requestError("MCP configuration could not be read", 409);
  }
}
function parse(source: string | undefined): JsonObject {
  try {
    const value: unknown = source === undefined ? {} : JSON.parse(source);
    if (
      !isObject(value) ||
      (value.mcpServers !== undefined && !isObject(value.mcpServers))
    )
      throw new Error();
    return value;
  } catch {
    throw requestError(
      "Repair the invalid mcp.json object before editing it",
      409,
    );
  }
}
/** Resolve existing and dangling links without replacing the configuration symlink. */
async function targetAt(
  path: string,
  seen = new Set<string>(),
): Promise<string> {
  const absolute = resolve(path);
  if (seen.has(absolute))
    throw requestError("MCP configuration has a circular link", 409);
  seen.add(absolute);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw requestError("MCP configuration path is unavailable", 409);
  }
  try {
    return await targetAt(
      resolve(dirname(absolute), await readlink(absolute)),
      seen,
    );
  } catch (error) {
    if (
      !["ENOENT", "EINVAL"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
  return join(await parentAt(dirname(absolute)), basename(absolute));
}
async function parentAt(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw requestError("MCP configuration directory is unavailable", 409);
    return join(await parentAt(dirname(path)), basename(path));
  }
}
const revisionOf = (target: string, source: string | undefined) =>
  createHash("sha256")
    .update(JSON.stringify([target, source ?? null]))
    .digest("hex");

function applyPatch(current: JsonObject, patch: JsonObject): JsonObject {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else
      Object.defineProperty(next, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return next;
}
function mergeValues(current: JsonObject, values: McpConfigValues): JsonObject {
  const patch: JsonObject = { ...values };
  for (const key of ["env", "headers", "oauth", "toolExposure"] as const) {
    if (values[key])
      patch[key] = applyPatch(
        key !== "toolExposure" && isObject(current[key]) ? current[key] : {},
        values[key],
      );
  }
  return applyPatch(current, patch);
}
function validate(
  name: string,
  value: JsonObject,
  scope: McpConfigScope,
): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    throw requestError(
      "Use letters, digits, underscores or hyphens for the server name",
      400,
    );
  const transport = projectEntry(name, value, scope).transport;
  if (value.command !== undefined && value.url !== undefined)
    throw requestError(
      "Choose either a stdio program or an HTTP URL, not both",
      400,
    );
  if (!transport)
    throw requestError("Choose a stdio program or a streamable HTTP URL", 400);
  if (transport === "stdio" && !(value.command as string).trim())
    throw requestError("A stdio program is required", 400);
  if (transport === "http") {
    let url: URL;
    try {
      url = new URL(value.url as string);
    } catch {
      throw requestError("Enter a valid HTTP or HTTPS URL", 400);
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw requestError("Enter a valid HTTP or HTTPS URL", 400);
    if (value.auth !== undefined) {
      if (scope === "project")
        throw requestError(
          "Pi provider authentication is only allowed in user MCP configuration",
          400,
        );
      if (
        url.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
        throw requestError(
          "Pi provider authentication requires HTTPS except on loopback",
          400,
        );
    }
  }
  // Validate supported fields without returning the submitted or stored secret in errors.
  const known = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => fieldNames.has(key) && key !== "type" && key !== "oauth",
    ),
  );
  if (known.exposure === "codemode-deferred") known.exposure = "codemode";
  if (isObject(known.toolExposure))
    known.toolExposure = Object.fromEntries(
      Object.entries(known.toolExposure).map(([key, mode]) => [
        key,
        mode === "codemode-deferred" ? "codemode" : mode,
      ]),
    );
  const oauthError = mcpOAuthError(value.oauth);
  if (oauthError) throw requestError(oauthError, 400);
  if (!valuesSchema.safeParse(known).success)
    throw requestError(
      "MCP configuration has invalid field values; check the server configuration",
      400,
    );
}

export class McpConfigService {
  constructor(private readonly agentDir = getAgentDir()) {}
  private path(cwd: string | null, scope: McpConfigScope) {
    if (scope === "user") return join(this.agentDir, "mcp.json");
    if (!cwd)
      throw requestError(
        "Select a project before editing project MCP configuration",
        409,
      );
    return join(cwd, ".pi", "mcp.json");
  }
  private async target(cwd: string | null, scope: McpConfigScope) {
    const path = this.path(cwd, scope);
    const project =
      scope === "project" ? await resolveProjectDirectory(cwd!) : null;
    const target = await targetAt(path);
    // A repository-controlled symlink cannot redirect a project edit into user config or another project.
    if (
      project !== null &&
      (await filesystemRelativePath(project, target)) === null
    )
      throw requestError(
        "Project mcp.json points outside this project; edit that file directly",
        409,
      );
    return target;
  }
  async read(cwd: string | null): Promise<McpConfigSnapshot> {
    const scopes: McpConfigScope[] =
      cwd === null ? ["user"] : ["user", "project"];
    const files = await Promise.all(
      scopes.map(async (scope) => {
        const path = this.path(cwd, scope);
        try {
          const target = await this.target(cwd, scope);
          const source = await readText(path);
          const parsed = parse(source);
          return {
            scope,
            path,
            revision: revisionOf(target, source),
            entries: Object.entries(
              isObject(parsed.mcpServers) ? parsed.mcpServers : {},
            ).map(([name, raw]) => projectEntry(name, raw, scope)),
          };
        } catch (error) {
          return {
            scope,
            path,
            revision: "",
            entries: [],
            error:
              error instanceof Error
                ? error.message
                : "MCP configuration is unavailable",
          };
        }
      }),
    );
    return { cwd, files };
  }
  async readConnection(
    cwd: string | null,
    input: McpConnectionRead,
  ): Promise<McpConnectionValues> {
    const request = mcpConnectionReadSchema.parse(input);
    const target = await this.target(cwd, request.scope);
    const source = await readText(target);
    if (revisionOf(target, source) !== request.revision)
      throw requestError(
        "MCP configuration changed elsewhere. Refresh files before viewing saved values.",
        409,
      );
    const parsed = parse(source);
    const servers = isObject(parsed.mcpServers) ? parsed.mcpServers : {};
    const entry = Object.hasOwn(servers, request.name)
      ? servers[request.name]
      : undefined;
    if (!isObject(entry))
      throw requestError(
        "That server is no longer available in this file",
        409,
      );
    // Return only literal connection values, never execute hooks or include credentials
    // from unrelated fields. URL/arguments themselves may contain user-saved secrets.
    return {
      ...(typeof entry.url === "string" ? { url: entry.url } : {}),
      ...(Array.isArray(entry.args) &&
      entry.args.every((arg) => typeof arg === "string")
        ? { args: entry.args as string[] }
        : {}),
    };
  }

  async save(cwd: string | null, input: McpConfigEdit): Promise<void> {
    const edit = mcpConfigEditSchema.parse(input);
    const path = this.path(cwd, edit.scope);
    const target = await this.target(cwd, edit.scope);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const lexical = join(await realpath(dirname(path)), basename(path));
    const lockPaths = await configurationEditLockPaths(lexical, target);
    // Add validates one namespace across both files. Share the user authority
    // with user-file edits so simultaneous additions cannot each pass against
    // the other file's old contents. Updates cannot rename an existing entry.
    let userTarget: string | undefined;
    if (edit.scope === "project" && edit.operation === "add") {
      const userPath = this.path(cwd, "user");
      userTarget = await this.target(cwd, "user");
      await mkdir(dirname(userTarget), { recursive: true, mode: 0o700 });
      const userLexical = join(
        await realpath(dirname(userPath)),
        basename(userPath),
      );
      lockPaths.push(
        ...(await configurationEditLockPaths(userLexical, userTarget)),
      );
    }
    const releases: Array<() => Promise<void>> = [];
    let compromised = false;
    const temporary = join(
      dirname(target),
      `.inspire-mcp-${randomUUID()}.json`,
    );
    try {
      for (const authority of [...new Set(lockPaths)].sort()) {
        try {
          releases.push(
            await lockfile.lock(authority, {
              realpath: false,
              retries: {
                retries: 20,
                factor: 1,
                minTimeout: 50,
                maxTimeout: 50,
              },
              onCompromised: () => {
                compromised = true;
              },
            }),
          );
        } catch {
          throw requestError(
            "MCP configuration is being edited elsewhere. Refresh files and try again.",
            409,
          );
        }
      }
      const source = await readText(path);
      if (revisionOf(target, source) !== edit.revision)
        throw requestError(
          "MCP configuration changed elsewhere. Refresh files before saving.",
          409,
        );
      const parsed = parse(source);
      const servers = isObject(parsed.mcpServers) ? parsed.mcpServers : {};
      const exists = Object.hasOwn(servers, edit.name);
      if (edit.operation === "add" ? exists : !exists)
        throw requestError(
          exists
            ? "That server already exists in this file"
            : "That server no longer exists in this file",
          409,
        );
      if (edit.operation === "remove") delete servers[edit.name];
      else {
        const current = edit.operation === "update" ? servers[edit.name] : {};
        if (!isObject(current))
          throw requestError(
            "Remove the invalid server entry before adding it again",
            409,
          );
        const values = edit.values ?? {};
        const value = mergeValues(current, values);
        if (
          isPolicyOnly(
            edit.operation === "update" ? current : value,
            edit.scope,
          )
        ) {
          if (Object.keys(values).some((key) => !policyFields.has(key)))
            throw requestError(
              "Project policy overrides can only edit enabled, exposure and toolExposure",
              400,
            );
          const user = parse(await readText(this.path(cwd, "user")));
          const base = isObject(user.mcpServers)
            ? user.mcpServers[edit.name]
            : undefined;
          if (!isObject(base))
            throw requestError(
              "Project policy override needs a same-name user server",
              409,
            );
          // Validate the inherited configuration in user scope without copying it to the project.
          validate(edit.name, { ...base, ...value }, "user");
        } else {
          validate(edit.name, value, edit.scope);
        }
        const names =
          edit.operation === "add"
            ? (await this.read(cwd)).files.flatMap((file) =>
                file.entries.map((entry) => entry.name),
              )
            : Object.keys(servers);
        if (
          names.some(
            (name) =>
              name !== edit.name &&
              name.replaceAll("-", "_") === edit.name.replaceAll("-", "_"),
          )
        )
          throw requestError(
            "Server names differing only in hyphens and underscores conflict in Pi",
            409,
          );
        Object.defineProperty(servers, edit.name, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      parsed.mcpServers = servers;
      const indent = source?.match(/^([ \t]+)\S/m)?.[1] ?? "  ";
      await writeFile(temporary, `${JSON.stringify(parsed, null, indent)}\n`, {
        mode: 0o600,
      });
      if (
        compromised ||
        (await this.target(cwd, edit.scope)) !== target ||
        (userTarget !== undefined &&
          (await this.target(cwd, "user")) !== userTarget) ||
        revisionOf(target, await readText(path)) !== edit.revision
      )
        throw requestError(
          "MCP configuration changed elsewhere. Refresh files before saving.",
          409,
        );
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
      await Promise.all(releases.reverse().map((release) => release()));
    }
  }
}
