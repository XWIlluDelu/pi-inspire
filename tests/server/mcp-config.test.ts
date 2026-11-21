import {
  access,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpConfigService } from "../../server/mcp-config.js";
import type { McpConfigEdit } from "../../shared/mcp.js";
import { closeHostApiFixture, configurationHost } from "./fixtures/host-api.js";
import { nativePiWorkspace } from "./fixtures/native-pi.js";

let root: string, agent: string, cwd: string, service: McpConfigService;
let userFile: string, projectFile: string;
let workspace: Awaited<ReturnType<typeof nativePiWorkspace>>;
const fixture = (hookMarker: string) => ({
  autoEnableCodemode: false,
  custom: { keep: true },
  mcpServers: {
    docs: {
      url: "https://user:password@example.invalid/private-token?key=url-secret",
      args: ["unused-argument-secret"],
      headers: {
        Authorization: "Bearer header-secret",
        "X-Other": "other-secret",
      },
      oauth: {
        clientSecret: "oauth-secret",
        clientId: "client-id",
        extensionField: "opaque-secret",
      },
      toolExposure: { "read_*": "direct", "*": "hidden" },
      description: "Docs",
      custom: "opaque-secret",
    },
    local: {
      command: "node",
      args: ["--token", "argument-secret"],
      env: { TOKEN: "env-secret", HOOK: `!touch "${hookMarker}"` },
      cwd: ".",
      enabled: false,
    },
  },
});
let source: ReturnType<typeof fixture>;
beforeEach(async () => {
  workspace = await nativePiWorkspace("inspire-mcp-config-", {});
  ({ root, agent, cwd } = workspace);
  userFile = join(agent, "mcp.json");
  projectFile = join(cwd, ".pi/mcp.json");
  source = fixture(join(root, "hook-ran"));
  await mkdir(join(cwd, ".pi"));
  await writeFile(userFile, JSON.stringify(source));
  service = new McpConfigService(agent);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const json = async () => JSON.parse(await readFile(userFile, "utf8"));
async function edit(value: Omit<McpConfigEdit, "revision">) {
  const file = (await service.read(cwd)).files.find(
    (file) => file.scope === value.scope,
  )!;
  return service.save(cwd, { ...value, revision: file.revision });
}
describe("MCP file configuration", () => {
  it("reads BOM-prefixed user files and rejects a project link outside its scope", async () => {
    const withBom = `\uFEFF${await readFile(userFile, "utf8")}`;
    await writeFile(userFile, withBom);
    expect(
      (await service.read(null)).files[0]!.entries.map((entry) => entry.name),
    ).toEqual(["docs", "local"]);
    await symlink(userFile, projectFile);
    expect((await service.read(cwd)).files[1]).toMatchObject({
      entries: [],
      error: expect.stringContaining("outside this project"),
    });
    await expect(
      service.save(cwd, {
        scope: "project",
        name: "docs",
        operation: "remove",
        revision: "a".repeat(64),
      }),
    ).rejects.toThrow("outside this project");
    expect(await readFile(userFile, "utf8")).toBe(withBom);
    await writeFile(userFile, '{"mcpServers": "invalid"}');
    expect((await service.read(null)).files[0]).toMatchObject({
      entries: [],
      error: expect.stringContaining("invalid mcp.json"),
    });
  });
  it("clears a registration override while keeping unknown fields and independent OAuth credentials", async () => {
    const user = (
      operation: "update" | "remove",
      values?: McpConfigEdit["values"],
    ) => edit({ scope: "user", name: "docs", operation, values });
    await user("update", {
      oauth: {
        clientRegistration: "auto",
        callbackUrl: "http://[::1]/custom-callback",
      },
    });
    await user("update", { oauth: { clientRegistration: null } });
    expect(await json()).toEqual({
      ...source,
      mcpServers: {
        ...source.mcpServers,
        docs: {
          ...source.mcpServers.docs,
          oauth: {
            ...source.mcpServers.docs.oauth,
            callbackUrl: "http://[::1]/custom-callback",
          },
        },
      },
    });
    const auth = join(agent, "mcp-auth.json");
    await writeFile(auth, "opaque-auth-fixture");
    await user("remove");
    expect((await json()).mcpServers.docs).toBeUndefined();
    expect(await readFile(auth, "utf8")).toBe("opaque-auth-fixture");
  });
  it("creates project configuration for inherited policy and restricts edits to that policy", async () => {
    await rm(join(cwd, ".pi"), { recursive: true });
    await edit({
      scope: "project",
      name: "docs",
      operation: "add",
      values: {
        enabled: false,
        exposure: "hidden",
        toolExposure: { "read_*": "direct" },
      },
    });
    const before = await readFile(projectFile, "utf8");
    await expect(
      edit({
        scope: "project",
        name: "docs",
        operation: "update",
        values: { headers: { Authorization: "private-secret" } },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(projectFile, "utf8")).toBe(before);

    await rm(userFile);
    await expect(
      edit({
        scope: "project",
        name: "local",
        operation: "add",
        values: { enabled: false },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("fences colliding cross-file names while permitting exact overrides", async () => {
    const files = (await service.read(cwd)).files;
    const results = await Promise.allSettled(
      files.map((file) =>
        service.save(cwd, {
          scope: file.scope,
          revision: file.revision,
          name: file.scope === "user" ? "review-server" : "review_server",
          operation: "add",
          values: { command: "not-executed", enabled: false },
        }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ status: 409 });
    const entries = (await service.read(cwd)).files.flatMap((file) =>
      file.entries
        .filter(({ name }) => name.replaceAll("-", "_") === "review_server")
        .map(({ name }) => ({ name, scope: file.scope })),
    );
    expect(entries).toHaveLength(1);
    const { name, scope } = entries[0]!;
    await edit({
      name,
      scope: scope === "user" ? "project" : "user",
      operation: "add",
      values: { command: "not-executed", enabled: false },
    });
  });

  it("validates merged OAuth registration and preserves the file until incompatible stored fields are explicitly removed", async () => {
    const save = (values: McpConfigEdit["values"]) =>
      edit({
        scope: "user",
        name: "docs",
        operation: "update",
        values,
      });
    await save({
      oauth: {
        clientRegistration: "dcr",
        clientName: "GUI client",
        callbackUrl: "http://[::1]/other-path",
      },
    });
    const dcr = await readFile(userFile, "utf8");
    await expect(
      save({ oauth: { clientRegistration: "cimd" } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(userFile, "utf8")).toBe(dcr);
    await save({
      oauth: {
        clientRegistration: "cimd",
        clientId: null,
        clientName: null,
        callbackUrl: "http://127.0.0.1:8765/callback",
        callbackPort: 8765,
      },
    });
    const before = await readFile(userFile, "utf8");
    for (const oauth of [
      { clientName: "GUI client" },
      { clientId: "registered-client" },
      { callbackUrl: "http://localhost/other-path" },
      { callbackUrl: "http://[::1]/callback" },
    ]) {
      await expect(save({ oauth })).rejects.toMatchObject({ status: 400 });
      expect(await readFile(userFile, "utf8")).toBe(before);
    }
    // Unrelated edits must not publish an invalid OAuth object already on disk.
    const invalid = JSON.stringify({
      mcpServers: {
        docs: {
          url: "https://example.invalid/mcp",
          oauth: { clientRegistration: "cimd", clientName: "invalid" },
        },
      },
    });
    await writeFile(userFile, invalid);
    await expect(save({ description: "Changed" })).rejects.toMatchObject({
      status: 400,
    });
    expect(await readFile(userFile, "utf8")).toBe(invalid);
  });

  it("rejects invalid connections and transport changes without echoing their values", async () => {
    const update = (values: McpConfigEdit["values"]) =>
      edit({ scope: "user", name: "docs", operation: "update", values });
    const before = await readFile(userFile, "utf8");
    for (const values of [
      { url: "file:///private-secret" },
      { command: "node" },
      { url: null, command: "node" },
      { oauth: { callbackUrl: "https://evil.invalid/private-secret" } },
      { oauth: { callbackUrl: "http://localhost:1/callback", callbackPort: 2 } },
    ]) {
      await expect(update(values)).rejects.toMatchObject({
        status: 400,
        message: expect.not.stringContaining("private-secret"),
      });
    }
    expect(await readFile(userFile, "utf8")).toBe(before);
  });
});

it("scopes MCP requests to an open session and reveals only the reviewed connection", async () => {
  const host = await configurationHost(workspace, { mcpConfig: service });
  try {
    const http = host.localRequest;
    const owner = { sessionId: host.sessionId, cwd: root };
    const closed = { sessionId: "closed", cwd };
    const endpoint = "/api/mcp-config";
    const read = (query = owner) => http.get(endpoint).query(query);
    const patch = (body: object, query = owner) =>
      http.patch(endpoint).query(query).send(body);
    const response = await read().expect(200);
    expect(response.body.cwd).toBe(cwd);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.files).toMatchObject([
      {
        scope: "user",
        entries: [
          {
            name: "docs",
            policyOnly: false,
            urlConfigured: true,
            headerKeys: ["Authorization", "X-Other"],
            oauthFields: ["clientSecret", "clientId", "extensionField"],
          },
          { name: "local", argumentCount: 2, envKeys: ["TOKEN", "HOOK"] },
        ],
      },
      { scope: "project", entries: [] },
    ]);
    expect(response.text).not.toMatch(
      /password|private-token|url-secret|header-secret|other-secret|oauth-secret|client-id|opaque-secret|argument-secret|env-secret|hook-ran/,
    );
    await expect(lstat(join(root, "hook-ran"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await read(closed).expect(409);
    const unselected = (await http.get(endpoint).expect(200)).body;
    expect(unselected.cwd).toBeNull();
    expect(unselected.files).toEqual([response.body.files[0]]);
    const revision = unselected.files[0].revision;
    const reveal = (name: string, query = owner, fields = {}) =>
      http
        .post(`${endpoint}/connection`)
        .query(query)
        .send({ scope: "user", name, revision, ...fields });
    const url = await reveal("docs").expect(200);
    expect(url.headers["cache-control"]).toBe("no-store");
    expect(url.body).toEqual({ url: source.mcpServers.docs.url });
    await reveal("docs", closed).expect(409);
    await reveal("docs", owner, { path: join(root, "arbitrary") }).expect(400);

    const update = {
      scope: "user",
      name: "local",
      revision,
      operation: "update",
      values: { command: "python" },
    };
    const original = await readFile(userFile, "utf8");
    const invalid = await patch({
      ...update,
      path: join(root, "arbitrary"),
      values: { headers: { Authorization: "request-secret" } },
    }).expect(400);
    expect(JSON.stringify(invalid.body)).not.toContain("request-secret");
    await patch(update, closed).expect(409);
    expect(await readFile(userFile, "utf8")).toBe(original);

    const addProject = {
      scope: "project",
      revision: response.body.files[1].revision,
      name: "needs-project",
      operation: "add",
      values: { command: "node" },
    };
    await http.patch(endpoint).send(addProject).expect(409);
    await rm(cwd, { recursive: true });
    const missing = (await read().expect(200)).body;
    expect(missing.files[1]).toMatchObject({
      scope: "project",
      revision: "",
      entries: [],
      error: expect.stringMatching(/Project path/),
    });
    const saved = (await patch(update).expect(200)).body;
    expect(saved).toMatchObject({
      saved: true,
      snapshot: {
        files: [expect.objectContaining({ scope: "user" }), missing.files[1]],
      },
    });
    expect((await json()).mcpServers.local.command).toBe("python");
    expect(saved.snapshot.files[0].revision).not.toBe(revision);
    const stale = await reveal("local").expect(409);
    expect(stale.body.error).toContain("Refresh files");
    expect(JSON.stringify(stale.body)).not.toContain("argument-secret");
    await patch(addProject).expect(400);
    await expect(access(cwd)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, ".pi/mcp.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await closeHostApiFixture(host);
  }
});
