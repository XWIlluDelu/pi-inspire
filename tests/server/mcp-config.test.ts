import {
  access,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import lockfile from "proper-lockfile";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpConfigService } from "../../server/mcp-config.js";
import { registerMcpConfigRoutes } from "../../server/mcp-config-routes.js";
import type { RuntimeLike } from "../../server/runtime.js";
import type { McpConfigEdit, McpConfigScope } from "../../shared/mcp.js";
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
  it("edits only the addressed file and subset, preserving secrets, unknown fields and tool order", async () => {
    const project = join(cwd, ".pi/mcp.json");
    await writeFile(
      project,
      JSON.stringify({
        mcpServers: {
          docs: {
            url: "https://project.invalid/mcp",
            env: { KEEP: "project-secret" },
          },
        },
        unrelated: 5,
      }),
    );
    const userBefore = await readFile(join(agent, "mcp.json"), "utf8");
    await edit({
      scope: "project",
      name: "docs",
      operation: "update",
      values: { timeout: 30, enabled: false },
    });
    expect(await readFile(join(agent, "mcp.json"), "utf8")).toBe(userBefore);
    expect(await json(project)).toMatchObject({
      unrelated: 5,
      mcpServers: {
        docs: {
          url: "https://project.invalid/mcp",
          env: { KEEP: "project-secret" },
          timeout: 30,
          enabled: false,
        },
      },
    });
    await edit({
      scope: "user",
      name: "docs",
      operation: "update",
      values: {
        description: "Changed",
        headers: { "X-Other": null, "X-New": "${TOKEN}" },
        oauth: { clientName: "fixture" },
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
          oauth: { ...fixture.mcpServers.docs.oauth, clientName: "fixture" },
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
  });
  it("edits project policy only without copying inherited transport or credentials", async () => {
    const project = join(cwd, ".pi/mcp.json");
    await writeFile(
      project,
      JSON.stringify({
        mcpServers: { docs: { enabled: false } },
        unrelated: 5,
      }),
    );
    const userBefore = await readFile(join(agent, "mcp.json"), "utf8");
    expect((await service.read(cwd)).files[1]!.entries[0]).toMatchObject({
      policyOnly: true,
      transport: null,
      enabled: false,
      exposure: null,
      urlConfigured: false,
      headerKeys: [],
      oauthFields: [],
    });
    await edit({
      scope: "project",
      name: "docs",
      operation: "update",
      values: {
        enabled: true,
        exposure: "hidden",
        toolExposure: { "read_*": "direct", "*": "hidden" },
      },
    });
    expect(await json(project)).toEqual({
      mcpServers: {
        docs: {
          enabled: true,
          exposure: "hidden",
          toolExposure: { "read_*": "direct", "*": "hidden" },
        },
      },
      unrelated: 5,
    });
    const before = await readFile(project, "utf8");
    for (const values of [
      { url: "https://private-secret.invalid/mcp" },
      { headers: { Authorization: "private-secret" } },
      { timeout: 30 },
    ]) {
      await expect(
        edit({ scope: "project", name: "docs", operation: "update", values }),
      ).rejects.toThrow("can only edit enabled, exposure and toolExposure");
      expect(await readFile(project, "utf8")).toBe(before);
    }
    await edit({
      scope: "project",
      name: "docs",
      operation: "update",
      values: { enabled: null, exposure: null, toolExposure: {} },
    });
    expect((await json(project)).mcpServers.docs).toEqual({ toolExposure: {} });
    expect((await service.read(cwd)).files[1]!.entries[0]).toMatchObject({
      enabled: null,
      exposure: null,
    });
    expect(await readFile(join(agent, "mcp.json"), "utf8")).toBe(userBefore);
    await rm(join(agent, "mcp.json"));
    await expect(
      edit({
        scope: "project",
        name: "docs",
        operation: "update",
        values: { enabled: false },
      }),
    ).rejects.toThrow("needs a same-name user server");
  });
  it("rejects cross-file namespace collisions on Add but permits exact overrides", async () => {
    await edit({
      scope: "user",
      name: "team-tools",
      operation: "add",
      values: { command: "node", enabled: false },
    });
    await expect(
      edit({
        scope: "project",
        name: "team_tools",
        operation: "add",
        values: { command: "node", enabled: false },
      }),
    ).rejects.toThrow("hyphens and underscores conflict");
    await edit({
      scope: "project",
      name: "team-tools",
      operation: "add",
      values: { command: "node", enabled: false },
    });
    await edit({
      scope: "project",
      name: "project-tools",
      operation: "add",
      values: { command: "node", enabled: false },
    });
    const before = await readFile(join(agent, "mcp.json"), "utf8");
    await expect(
      edit({
        scope: "user",
        name: "project_tools",
        operation: "add",
        values: { command: "node", enabled: false },
      }),
    ).rejects.toThrow("hyphens and underscores conflict");
    expect(await readFile(join(agent, "mcp.json"), "utf8")).toBe(before);
  });
  it("supports adding transports and explicit removal without touching OAuth storage", async () => {
    await writeFile(join(agent, "mcp-auth.json"), "opaque-auth-fixture");
    await edit({
      scope: "user",
      name: "stdio-tools",
      operation: "add",
      values: {
        command: "node",
        args: ["tool.js", "argument with spaces"],
        env: { TOKEN: "${TOKEN}" },
        exposure: "deferred",
      },
    });
    await edit({
      scope: "project",
      name: "http-tools",
      operation: "add",
      values: {
        url: "http://localhost:1234/mcp",
        oauth: {
          callbackUrl: "http://127.0.0.1:1235/callback",
          callbackPort: 1235,
        },
      },
    });
    expect((await json()).mcpServers["stdio-tools"].args).toEqual([
      "tool.js",
      "argument with spaces",
    ]);
    await edit({ scope: "user", name: "docs", operation: "remove" });
    expect((await json()).mcpServers.docs).toBeUndefined();
    expect(await readFile(join(agent, "mcp-auth.json"), "utf8")).toBe(
      "opaque-auth-fixture",
    );
  });
  it("refuses stale or concurrent writes and leaves malformed files intact", async () => {
    const file = (await service.read(cwd)).files[0]!;
    const result = await Promise.allSettled(
      ["first", "second"].map((description) =>
        service.save(cwd, {
          scope: "user",
          name: "docs",
          revision: file.revision,
          operation: "update",
          values: { description },
        }),
      ),
    );
    expect(result.map((item) => item.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    await writeFile(
      join(agent, "mcp.json"),
      '{"mcpServers": "secret-invalid-json"',
    );
    expect((await service.read(cwd)).files[0]!.error).toBe(
      "Repair the invalid mcp.json object before editing it",
    );
    await expect(
      service.save(cwd, {
        scope: "user",
        name: "docs",
        revision: file.revision,
        operation: "remove",
      }),
    ).rejects.toThrow("changed elsewhere");
    expect(await readFile(join(agent, "mcp.json"), "utf8")).toContain(
      "secret-invalid-json",
    );
  });
  it("saves a regular filename case alias on a native case-insensitive volume", async (context) => {
    const lower = join(agent, "mcp.json");
    const upper = join(agent, "MCP.JSON");
    await rename(lower, upper);
    if (
      !(await access(lower).then(
        () => true,
        () => false,
      ))
    )
      return context.skip();
    await edit({
      scope: "user",
      name: "docs",
      operation: "update",
      values: { timeout: 27 },
    });
    expect((await json(upper)).mcpServers.docs.timeout).toBe(27);
  });

  it.each(["regular", "symlink"])(
    "rejects a %s file retargeted during its save even with identical contents",
    async (kind) => {
      const file = join(agent, "mcp.json");
      const original = await readFile(file, "utf8");
      const initialTarget = join(root, "original.json");
      if (kind === "symlink") {
        await rename(file, initialTarget);
        await symlink(initialTarget, file);
      }
      const replacement = join(root, "replacement.json");
      await writeFile(replacement, original);
      const before = (await service.read(cwd)).files[0]!;
      const nativeLock = lockfile.lock.bind(lockfile);
      const locked: string[] = [];
      let changed = false;
      vi.spyOn(lockfile, "lock").mockImplementation(
        async (authority, options) => {
          const release = await nativeLock(authority, options);
          locked.push(authority);
          if (!changed) {
            changed = true;
            await rm(file);
            await symlink(replacement, file);
          }
          return release;
        },
      );
      await expect(
        service.save(cwd, {
          scope: "user",
          name: "docs",
          operation: "update",
          revision: before.revision,
          values: { timeout: 28 },
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(changed).toBe(true);
      expect(locked).toEqual(
        kind === "symlink" ? [file, initialTarget].sort() : [file],
      );
      expect((await lstat(file)).isSymbolicLink()).toBe(true);
      expect(await readFile(replacement, "utf8")).toBe(original);
      if (kind === "symlink")
        expect(await readFile(initialTarget, "utf8")).toBe(original);
      await expect(access(`${file}.lock`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(`${initialTarget}.lock`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("preserves user symlinks but refuses project paths outside their selected authority", async () => {
    const userPath = join(agent, "mcp.json"),
      target = join(root, "linked.json");
    await writeFile(target, JSON.stringify(fixture));
    await rm(userPath);
    await symlink(target, userPath);
    await edit({
      scope: "user",
      name: "docs",
      operation: "update",
      values: { timeout: 15 },
    });
    expect((await lstat(userPath)).isSymbolicLink()).toBe(true);
    expect((await json(target)).mcpServers.docs.timeout).toBe(15);
    await symlink(target, join(cwd, ".pi/mcp.json"));
    const project = (await service.read(cwd)).files[1]!;
    expect(project.error).toContain("outside this project");
    expect(project.entries).toEqual([]);
    await expect(
      service.save(cwd, {
        scope: "project",
        name: "docs",
        operation: "remove",
        revision: "a".repeat(64),
      }),
    ).rejects.toThrow("outside this project");
    expect((await json(target)).mcpServers.docs).toBeDefined();
  });
  it("creates a missing configuration directory and binds revision to the symlink target", async () => {
    await rm(join(cwd, ".pi"), { recursive: true });
    await edit({
      scope: "project",
      name: "new",
      operation: "add",
      values: { command: "fixture" },
    });
    expect((await json(join(cwd, ".pi/mcp.json"))).mcpServers.new.command).toBe(
      "fixture",
    );
    const user = join(agent, "mcp.json");
    const before = (await service.read(cwd)).files[0]!;
    const same = join(root, "same.json");
    await writeFile(same, await readFile(user));
    await rm(user);
    await symlink(same, user);
    await expect(
      service.save(cwd, {
        scope: "user",
        name: "docs",
        operation: "remove",
        revision: before.revision,
      }),
    ).rejects.toThrow("changed elsewhere");
  });
  it.each([
    ["bad/name", { command: "node" }],
    ["sse", { url: "file:///private-secret" }],
    ["mixed", { command: "node", url: "https://example.invalid" }],
    ["local", { timeout: -1 }],
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
        edit({
          scope: "user",
          name,
          operation: name === "local" ? "update" : "add",
          values: values as McpConfigEdit["values"],
        }),
      ).rejects.toThrow();
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
  it.each(["unselected", "missing", "not-directory"] as const)(
    "keeps user reads and add/update/remove independent of the %s project",
    async (project) => {
      const path = join(root, "unavailable-project");
      if (project === "not-directory") await writeFile(path, "keep");
      const owner = project === "unselected" ? {} : { cwd: path };
      const response = await request(app())
        .get("/api/mcp-config")
        .query(owner)
        .expect(200);
      expect(response.body.cwd).toBe(project === "unselected" ? null : path);
      expect(response.body.files[0].entries).toHaveLength(2);
      expect(response.headers["cache-control"]).toBe("no-store");
      if (project === "unselected") expect(response.body.files).toHaveLength(1);
      else
        expect(response.body.files[1]).toMatchObject({
          scope: "project",
          revision: "",
          entries: [],
          error: expect.stringMatching(/Project path/),
        });

      let config = response.body;
      for (const operation of ["add", "update", "remove"] as const) {
        const result = await request(app())
          .patch("/api/mcp-config")
          .query(owner)
          .send({
            scope: "user",
            revision: config.files[0].revision,
            name: "independent",
            operation,
            ...(operation === "add"
              ? { values: { command: "node" } }
              : operation === "update"
                ? { values: { timeout: 25 } }
                : {}),
          })
          .expect(200);
        expect(result.body.saved).toBe(true);
        config = result.body.snapshot;
        const stored = (await json()).mcpServers.independent;
        if (operation === "add") expect(stored.command).toBe("node");
        if (operation === "update") expect(stored.timeout).toBe(25);
        if (operation === "remove") expect(stored).toBeUndefined();
      }
      await request(app())
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
      if (project === "not-directory")
        expect(await readFile(path, "utf8")).toBe("keep");
      else await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps user configuration accessible when an addressed session's project disappears", async () => {
    await rm(cwd, { recursive: true });
    const response = await request(app())
      .get("/api/mcp-config")
      .query({ sessionId: "open", cwd: root })
      .expect(200);
    expect(response.body.cwd).toBe(cwd);
    expect(response.body.files[0].entries).toHaveLength(2);
    expect(response.body.files[1].error).toMatch(/Project path does not exist/);
    await request(app())
      .patch("/api/mcp-config")
      .query({ sessionId: "open", cwd: root })
      .send({
        scope: "user",
        revision: response.body.files[0].revision,
        name: "docs",
        operation: "update",
        values: { timeout: 25 },
      })
      .expect(200);
    expect((await json()).mcpServers.docs.timeout).toBe(25);
    await expect(access(cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses session cwd over supplied cwd and accepts no caller-supplied file path", async () => {
    const response = await request(app())
      .get("/api/mcp-config")
      .query({ sessionId: "open", cwd: root })
      .expect(200);
    expect(response.body.cwd).toBe(cwd);
    expect(response.headers["cache-control"]).toBe("no-store");
    await request(app())
      .get("/api/mcp-config")
      .query({ sessionId: "closed", cwd })
      .expect(409);
    const file = response.body.files[0];
    const bad = await request(app())
      .patch("/api/mcp-config")
      .query({ sessionId: "open" })
      .send({
        scope: "user" as McpConfigScope,
        revision: file.revision,
        name: "docs",
        operation: "update",
        path: join(root, "arbitrary"),
        values: { headers: { Authorization: "request-secret" } },
      })
      .expect(400);
    expect(JSON.stringify(bad.body)).not.toContain("request-secret");
    await request(app())
      .patch("/api/mcp-config")
      .query({ sessionId: "closed", cwd })
      .send({
        scope: "user",
        revision: file.revision,
        name: "docs",
        operation: "update",
        values: { timeout: 25 },
      })
      .expect(409);
    expect((await json()).mcpServers.docs.timeout).toBeUndefined();
    await request(app())
      .patch("/api/mcp-config")
      .query({ sessionId: "open" })
      .send({
        scope: "user",
        revision: file.revision,
        name: "docs",
        operation: "update",
        values: { timeout: 25 },
      })
      .expect(200);
    expect((await json()).mcpServers.docs.timeout).toBe(25);
  });
});
