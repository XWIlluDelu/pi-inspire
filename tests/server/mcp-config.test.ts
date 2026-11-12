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
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpConfigService } from "../../server/mcp-config.js";
import { registerMcpConfigRoutes } from "../../server/mcp-config-routes.js";
import type { RuntimeLike } from "../../server/runtime.js";
import type { McpConfigEdit } from "../../shared/mcp.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";

let root: string, agent: string, cwd: string, service: McpConfigService;
const fixture = {
  autoEnableCodemode: false,
  custom: { keep: true },
  mcpServers: {
    docs: {
      url: "https://user:password@example.invalid/private-token?key=url-secret",
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
      env: { TOKEN: "env-secret", HOOK: "!touch must-not-exist" },
      cwd: ".",
      enabled: false,
    },
  },
};
beforeEach(async () => {
  const workspace = await nativePiWorkspace("inspire-mcp-config-", {});
  ({ root, agent, cwd } = workspace);
  stubNativePiEnvironment(workspace.env);
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(agent, "mcp.json"), JSON.stringify(fixture));
  service = new McpConfigService(agent);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const json = async (path = join(agent, "mcp.json")) =>
  JSON.parse(await readFile(path, "utf8"));
async function edit(value: Omit<McpConfigEdit, "revision">) {
  const file = (await service.read(cwd)).files.find(
    (file) => file.scope === value.scope,
  )!;
  return service.save(cwd, { ...value, revision: file.revision });
}
describe("MCP file configuration", () => {
  it("edits BOM-prefixed user symlinks within scope and rejects stale file revisions", async () => {
    const user = join(agent, "mcp.json");
    const target = join(root, "linked.json");
    const original = await readFile(user, "utf8");
    const before = (await service.read(null)).files[0]!;
    await writeFile(target, original);
    await rm(user);
    await symlink(target, user);
    const update = (revision: string) =>
      service.save(null, {
        scope: "user",
        name: "docs",
        revision,
        operation: "update",
        values: { description: "Updated docs" },
      });
    await expect(update(before.revision)).rejects.toThrow("changed elsewhere");
    expect(await readFile(target, "utf8")).toBe(original);

    const withBom = `\uFEFF${original}`;
    await writeFile(target, withBom);
    const file = (await service.read(null)).files[0]!;
    expect(file.entries.map((entry) => entry.name)).toEqual(["docs", "local"]);
    expect(await readFile(target, "utf8")).toBe(withBom);

    await update(file.revision);
    expect((await lstat(user)).isSymbolicLink()).toBe(true);
    expect(await json(target)).toEqual({
      ...fixture,
      mcpServers: {
        ...fixture.mcpServers,
        docs: { ...fixture.mcpServers.docs, description: "Updated docs" },
      },
    });

    await symlink(target, join(cwd, ".pi/mcp.json"));
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
    expect((await json(target)).mcpServers.docs.description).toBe(
      "Updated docs",
    );

    const saved = (await service.read(null)).files[0]!;
    const bomOnlyChange = `\uFEFF${await readFile(target, "utf8")}`;
    const malformed = '{"mcpServers": "invalid-json"';
    for (const changed of [bomOnlyChange, malformed]) {
      await writeFile(target, changed);
      await expect(update(saved.revision)).rejects.toMatchObject({
        status: 409,
      });
      expect(await readFile(target, "utf8")).toBe(changed);
    }
    expect((await service.read(null)).files[0]).toMatchObject({
      entries: [],
      error: expect.stringContaining("invalid mcp.json"),
    });
  });
  it("projects source and policy without resolving hooks or returning credential-bearing fields", async () => {
    const hookMarker = join(root, "hook-ran");
    const source = structuredClone(fixture);
    source.mcpServers.local.env.HOOK = `!touch ${hookMarker}`;
    await writeFile(join(agent, "mcp.json"), JSON.stringify(source));
    await writeFile(
      join(cwd, ".pi/mcp.json"),
      JSON.stringify({
        mcpServers: { docs: { url: "http://127.0.0.1/mcp", enabled: false } },
      }),
    );
    const snapshot = await service.read(cwd);
    expect(
      snapshot.files.map((file) => [
        file.scope,
        file.entries.map((entry) => entry.name),
      ]),
    ).toEqual([
      ["user", ["docs", "local"]],
      ["project", ["docs"]],
    ]);
    expect(snapshot.files[0]!.entries[0]).toMatchObject({
      policyOnly: false,
      urlConfigured: true,
      headerKeys: ["Authorization", "X-Other"],
      oauthFields: ["clientSecret", "clientId", "extensionField"],
    });
    expect(snapshot.files[0]!.entries[1]).toMatchObject({
      argumentCount: 2,
      envKeys: ["TOKEN", "HOOK"],
    });
    const wire = JSON.stringify(snapshot);
    for (const secret of [
      "password",
      "private-token",
      "url-secret",
      "header-secret",
      "other-secret",
      "oauth-secret",
      "client-id",
      "opaque-secret",
      "argument-secret",
      "env-secret",
      hookMarker,
    ])
      expect(wire).not.toContain(secret);
    await expect(lstat(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("merges field edits in order, preserves secrets and keeps OAuth storage independent", async () => {
    const automaticOauth = {
      clientRegistration: "auto",
      clientName: "fixture",
      callbackUrl: "http://[::1]/custom-callback",
    } as const;
    await edit({
      scope: "user",
      name: "docs",
      operation: "update",
      values: { oauth: automaticOauth },
    });
    await edit({
      scope: "user",
      name: "docs",
      operation: "update",
      values: {
        description: "Changed",
        headers: { "X-Other": null, "X-New": "${TOKEN}" },
        toolExposure: { "*": "hidden", "read_*": "codemode" },
      },
    });
    const saved = await json();
    expect(saved).toMatchObject({
      autoEnableCodemode: false,
      custom: { keep: true },
      mcpServers: {
        docs: {
          ...fixture.mcpServers.docs,
          description: "Changed",
          headers: {
            Authorization: "Bearer header-secret",
            "X-New": "${TOKEN}",
          },
          oauth: { ...fixture.mcpServers.docs.oauth, ...automaticOauth },
          toolExposure: { "*": "hidden", "read_*": "codemode" },
        },
        local: fixture.mcpServers.local,
      },
    });
    expect(saved.mcpServers.docs.headers).not.toHaveProperty("X-Other");
    expect(Object.keys(saved.mcpServers.docs.toolExposure)).toEqual([
      "*",
      "read_*",
    ]);
    expect((await service.read(cwd)).files[0]!.entries[0]).toMatchObject({
      oauthClientRegistration: "auto",
    });

    await edit({
      scope: "user",
      name: "docs",
      operation: "update",
      values: { oauth: { clientRegistration: null } },
    });
    const oauth = (await json()).mcpServers.docs.oauth;
    expect(oauth).not.toHaveProperty("clientRegistration");
    expect(oauth.clientSecret).toBe(fixture.mcpServers.docs.oauth.clientSecret);
    expect((await service.read(cwd)).files[0]!.entries[0]).not.toHaveProperty(
      "oauthClientRegistration",
    );

    const auth = join(agent, "mcp-auth.json");
    await writeFile(auth, "opaque-auth-fixture");
    await edit({ scope: "user", name: "docs", operation: "remove" });
    expect((await json()).mcpServers.docs).toBeUndefined();
    expect(await readFile(auth, "utf8")).toBe("opaque-auth-fixture");
  });
  it("creates project configuration for inherited policy and restricts edits to that policy", async () => {
    const project = join(cwd, ".pi/mcp.json");
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
    expect((await json(project)).mcpServers.docs).toEqual({
      enabled: false,
      exposure: "hidden",
      toolExposure: { "read_*": "direct" },
    });
    const before = await readFile(project, "utf8");
    await expect(
      edit({
        scope: "project",
        name: "docs",
        operation: "update",
        values: { headers: { Authorization: "private-secret" } },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(project, "utf8")).toBe(before);
    await edit({
      scope: "project",
      name: "docs",
      operation: "update",
      values: { enabled: null, exposure: null, toolExposure: {} },
    });
    expect((await json(project)).mcpServers.docs).toEqual({ toolExposure: {} });

    await rm(join(agent, "mcp.json"));
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

    await edit({
      scope: "project",
      name: "project-tools",
      operation: "add",
      values: { command: "not-executed", enabled: false },
    });
    await expect(
      edit({
        scope: "user",
        name: "project_tools",
        operation: "add",
        values: { command: "not-executed", enabled: false },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("validates merged OAuth registration and preserves the file until incompatible stored fields are explicitly removed", async () => {
    const path = join(agent, "mcp.json");
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          docs: {
            url: "https://example.invalid/mcp",
            oauth: {
              clientRegistration: "cimd",
              clientSecret: "protected-secret",
            },
          },
        },
      }),
    );
    expect((await service.read(cwd)).files[0]!.entries[0]).toMatchObject({
      oauthClientRegistration: "cimd",
      oauthFields: ["clientRegistration", "clientSecret"],
    });
    const before = await readFile(path, "utf8");
    for (const oauth of [
      { clientName: "GUI client" },
      { clientId: "registered-client" },
      { callbackUrl: "http://localhost/other-path" },
      { callbackUrl: "http://[::1]/callback" },
    ]) {
      await expect(
        edit({
          scope: "user",
          name: "docs",
          operation: "update",
          values: { oauth },
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await readFile(path, "utf8")).toBe(before);
    }
    await edit({
      scope: "user",
      name: "docs",
      operation: "update",
      values: {
        oauth: {
          clientRegistration: "dcr",
          clientName: "GUI client",
          callbackUrl: "http://[::1]/other-path",
        },
      },
    });
    const dcr = await readFile(path, "utf8");
    await expect(
      edit({
        scope: "user",
        name: "docs",
        operation: "update",
        values: {
          oauth: { clientRegistration: "cimd" },
        },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(path, "utf8")).toBe(dcr);
    await edit({
      scope: "user",
      name: "docs",
      operation: "update",
      values: {
        oauth: {
          clientRegistration: "cimd",
          clientName: null,
          callbackUrl: "http://127.0.0.1:8765/callback",
          callbackPort: 8765,
        },
      },
    });
    expect((await json()).mcpServers.docs.oauth).toEqual({
      clientRegistration: "cimd",
      clientSecret: "protected-secret",
      callbackUrl: "http://127.0.0.1:8765/callback",
      callbackPort: 8765,
    });
    // Unrelated edits must not publish an invalid OAuth object already on disk.
    const invalid = JSON.stringify({
      mcpServers: {
        docs: {
          url: "https://example.invalid/mcp",
          oauth: { clientRegistration: "cimd", clientName: "invalid" },
        },
      },
    });
    await writeFile(path, invalid);
    await expect(
      edit({
        scope: "user",
        name: "docs",
        operation: "update",
        values: { description: "Changed" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(path, "utf8")).toBe(invalid);
  });

  it.each([
    ["sse", { url: "file:///private-secret" }],
    ["mixed", { command: "node", url: "https://example.invalid" }],
    [
      "oauth",
      {
        url: "https://example.invalid",
        oauth: { callbackUrl: "https://evil.invalid/private-secret" },
      },
    ],
    [
      "oauth-port",
      {
        url: "https://example.invalid",
        oauth: { callbackUrl: "http://localhost:1/callback", callbackPort: 2 },
      },
    ],
  ])(
    "rejects invalid edit %s without echoing submitted secrets",
    async (name, values) => {
      const before = await readFile(join(agent, "mcp.json"), "utf8");
      await expect(
        edit({ scope: "user", name, operation: "add", values }),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.not.stringContaining("private-secret"),
      });
      expect(await readFile(join(agent, "mcp.json"), "utf8")).toBe(before);
    },
  );
});

describe("MCP HTTP ownership", () => {
  function app() {
    const app = express();
    app.use(express.json());
    registerMcpConfigRoutes(app, {
      mcpConfig: service,
      runtime: {
        sessionCwd: (id: string) => (id === "open" ? cwd : null),
      } as RuntimeLike,
    });
    app.use(
      (
        error: Error & { status?: number },
        _request: express.Request,
        response: express.Response,
        _next: express.NextFunction,
      ) => response.status(error.status ?? 400).json({ error: error.message }),
    );
    return app;
  }
  it("reads, reveals and edits only the authorized configuration at its reviewed revision", async () => {
    const http = request(app());
    const owner = { sessionId: "open", cwd: root };
    const closed = { sessionId: "closed", cwd };
    const read = (query = owner) => http.get("/api/mcp-config").query(query);
    const patch = (body: object, query = owner) =>
      http.patch("/api/mcp-config").query(query).send(body);
    const response = await read().expect(200);
    expect(response.body.cwd).toBe(cwd);
    expect(response.headers["cache-control"]).toBe("no-store");
    await read(closed).expect(409);

    const [user, project] = response.body.files;
    const reveal = (name: string, query = owner, fields = {}) =>
      http
        .post("/api/mcp-config/connection")
        .query(query)
        .send({ scope: "user", name, revision: user.revision, ...fields });
    const before = await readFile(join(agent, "mcp.json"), "utf8");
    const url = await reveal("docs").expect(200);
    expect(url.headers["cache-control"]).toBe("no-store");
    expect(url.body).toEqual({ url: fixture.mcpServers.docs.url });
    const args = await reveal("local").expect(200);
    expect(args.body).toEqual({ args: fixture.mcpServers.local.args });
    await reveal("docs", closed).expect(409);
    await reveal("docs", owner, { path: join(root, "arbitrary") }).expect(400);

    const update = {
      scope: "user",
      name: "local",
      revision: user.revision,
      operation: "update",
      values: { args: [args.body.args[0], "new-value"] },
    };
    const invalidPath = await patch({
      ...update,
      path: join(root, "arbitrary"),
      values: { headers: { Authorization: "request-secret" } },
    }).expect(400);
    expect(JSON.stringify(invalidPath.body)).not.toContain("request-secret");
    await patch(update, closed).expect(409);
    expect(await readFile(join(agent, "mcp.json"), "utf8")).toBe(before);

    await patch(update).expect(200);
    expect((await json()).mcpServers.local).toEqual({
      ...fixture.mcpServers.local,
      args: ["--token", "new-value"],
    });
    const stale = await reveal("local").expect(409);
    expect(stale.body.error).toContain("Refresh files");
    expect(JSON.stringify(stale.body)).not.toContain("argument-secret");

    await patch({
      scope: "project",
      revision: project.revision,
      name: "docs",
      operation: "add",
      values: { enabled: false },
    }).expect(200);
    expect((await json(join(cwd, ".pi/mcp.json"))).mcpServers.docs).toEqual({
      enabled: false,
    });
    await expect(access(join(root, ".pi/mcp.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["unselected", "removed directory"] as const)(
    "keeps user configuration editable with an unavailable project (%s)",
    async (project) => {
      if (project === "removed directory") await rm(cwd, { recursive: true });
      const owner =
        project === "unselected" ? {} : { sessionId: "open", cwd: root };
      const http = request(app());
      const response = await http
        .get("/api/mcp-config")
        .query(owner)
        .expect(200);
      expect(response.body.files[0].entries).toHaveLength(2);
      if (project === "unselected") {
        expect(response.body.cwd).toBeNull();
        expect(response.body.files).toHaveLength(1);
      } else {
        expect(response.body.cwd).toBe(cwd);
        expect(response.body.files[1]).toMatchObject({
          scope: "project",
          revision: "",
          entries: [],
          error: expect.stringMatching(/Project path/),
        });
      }
      const editUser = await http
        .patch("/api/mcp-config")
        .query(owner)
        .send({
          scope: "user",
          revision: response.body.files[0].revision,
          name: "docs",
          operation: "update",
          values: { timeout: 25 },
        })
        .expect(200);
      expect(editUser.body.saved).toBe(true);
      expect((await json()).mcpServers.docs.timeout).toBe(25);

      await http
        .patch("/api/mcp-config")
        .query(owner)
        .send({
          scope: "project",
          revision: "a".repeat(64),
          name: "not-created",
          operation: "add",
          values: { command: "node" },
        })
        .expect(project === "unselected" ? 409 : 400);
      if (project === "removed directory")
        await expect(access(cwd)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
