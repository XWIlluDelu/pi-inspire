import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { McpConfigService } from "../../server/mcp-config.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { ProjectTrustStore, piInstallation } from "../../server/pi-runtime.js";
import type { McpConfigEdit } from "../../shared/mcp.js";
import { nativePiWorkspace } from "./fixtures/native-pi.js";

it("Pi loads saved CIMD, dynamic and pre-registered OAuth configurations after partial edits", async () => {
  const workspace = await nativePiWorkspace("inspire-mcp-oauth-", {});
  const { root, agent, cwd } = workspace;
  try {
    const service = new McpConfigService(agent);
    const variants = {
      cimd: {
        clientRegistration: "cimd" as const,
        callbackUrl: "http://localhost:8765/callback",
      },
      dynamic: {
        clientRegistration: "dcr" as const,
        clientName: "Fixture client",
        callbackUrl: "http://[::1]/custom-callback",
      },
      registered: { clientId: "fixture-id", clientSecret: "fixture-secret" },
    };
    for (const [name, oauth] of Object.entries(variants)) {
      await service.save(null, {
        scope: "user",
        name,
        operation: "add",
        revision: (await service.read(null)).files[0]!.revision,
        values: { url: "https://example.invalid/mcp", enabled: false, oauth },
      });
    }
    await service.save(null, {
      scope: "user",
      name: "cimd",
      operation: "update",
      revision: (await service.read(null)).files[0]!.revision,
      values: { oauth: { scope: "read" } },
    });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [piInstallation.cliPath, "mcp", "list", "--json"],
      { cwd, env: workspace.env, timeout: 15_000 },
    );
    const loaded = JSON.parse(stdout);
    expect(loaded.errors).toEqual([]);
    expect(loaded.servers).toEqual(
      Object.keys(variants).map((name) =>
        expect.objectContaining({ name, enabled: false, state: "disabled" }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it("Pi consumes saved MCP files with native trust/precedence while its existing RPC worker keeps loaded connections", async () => {
  const workspace = await nativePiWorkspace("inspire-mcp-native-", {});
  const { root, agent, cwd } = workspace;
  let initializations = 0;
  const authorizations: Array<string | undefined> = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: unknown = {};
    if (message.method === "initialize") {
      initializations++;
      authorizations.push(request.headers.authorization);
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "isolated-fixture", version: "1" },
      };
    } else if (message.method === "tools/list") {
      result = {
        tools: [
          {
            name: "read_fixture",
            description: "Read fixture",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const service = new McpConfigService(agent);
  async function edit(value: Omit<McpConfigEdit, "revision">) {
    const file = (await service.read(cwd)).files.find(
      (file) => file.scope === value.scope,
    )!;
    await service.save(cwd, { ...value, revision: file.revision });
  }
  const rpc = new PiRpcProcess({
    cwd,
    env: workspace.env,
    args: [
      "--no-session",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-themes",
      "--no-prompt-templates",
      "--no-tools",
      "--extension",
      "builtin:mcp",
    ],
  });
  const events: Record<string, unknown>[] = [];
  rpc.on("event", (event) => events.push(event));
  async function command(message: string) {
    events.length = 0;
    const result = await rpc.request({ type: "prompt", message });
    return {
      result,
      notifications: events
        .filter(
          (event) =>
            event.type === "extension_ui_request" && event.method === "notify",
        )
        .map((event) => event.message)
        .join("\n"),
    };
  }
  try {
    await mkdir(join(cwd, ".pi"));
    await edit({
      scope: "user",
      name: "remote",
      operation: "add",
      values: {
        url,
        exposure: "direct",
        headers: { Authorization: "Bearer isolated-mcp-secret" },
      },
    });
    await edit({
      scope: "user",
      name: "local",
      operation: "add",
      values: {
        command: process.execPath,
        args: ["not-executed"],
        enabled: false,
      },
    });
    await edit({
      scope: "project",
      name: "remote",
      operation: "add",
      values: { url, enabled: false },
    });
    await rpc.start();
    const inventory = await rpc.request({ type: "get_commands" });
    expect(JSON.stringify(inventory)).toContain('"name":"mcp"');
    const before = await command("/mcp");
    expect(before.notifications).toContain("remote");
    expect(before.notifications).toMatch(/connected|1 tool/);
    expect(initializations).toBe(1);
    await edit({
      scope: "user",
      name: "remote",
      operation: "update",
      values: { enabled: false },
    });
    const loaded = await command("/mcp");
    expect(loaded.notifications).toBe(before.notifications);
    const unsupported = await command("/mcp disable remote");
    expect(unsupported.result).toMatchObject({ disposition: "handled" });
    expect(unsupported.notifications).toContain("Usage:");
    const reconnect = await command("/mcp reconnect remote");
    expect(reconnect.notifications).toContain("Reconnected");
    expect(initializations).toBe(2);
    // The independent native CLI reads disk, not the RPC worker's existing connection.
    const list = async () =>
      JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            [piInstallation.cliPath, "mcp", "list", "--json"],
            { cwd, env: workspace.env, timeout: 15_000 },
          )
        ).stdout,
      );
    const saved = await list();
    expect(JSON.stringify(saved)).toContain("disabled");
    expect(initializations).toBe(2);
    await edit({
      scope: "user",
      name: "remote",
      operation: "update",
      values: { enabled: true },
    });
    new ProjectTrustStore(agent).set(cwd, true);
    const trusted = await list();
    expect(JSON.stringify(trusted)).toContain("project");
    expect(initializations).toBe(2);

    // Pi 1.1 adds native policy-only project overrides; Pi 1.0 requires full entries.
    const [major, minor] = piInstallation.version.split(".").map(Number);
    if (major! > 1 || (major === 1 && minor! >= 1)) {
      const project = join(cwd, ".pi/mcp.json");
      await rm(project);
      expect((await service.read(cwd)).files[1]!.entries).toEqual([]);
      const userBefore = await readFile(join(agent, "mcp.json"), "utf8");
      await edit({
        scope: "project",
        name: "remote",
        operation: "add",
        values: { enabled: false },
      });
      expect(JSON.parse(await readFile(project, "utf8"))).toEqual({
        mcpServers: { remote: { enabled: false } },
      });
      const created = await list();
      expect(created.errors).toEqual([]);
      expect(
        created.servers.find(
          (entry: { name: string }) => entry.name === "remote",
        ),
      ).toMatchObject({
        enabled: false,
        source: join(agent, "mcp.json"),
        override: project,
        state: "disabled",
      });
      expect(initializations).toBe(2);
      expect((await service.read(cwd)).files[1]!.entries[0]).toMatchObject({
        policyOnly: true,
        transport: null,
        headerKeys: [],
        urlConfigured: false,
      });
      await edit({
        scope: "project",
        name: "remote",
        operation: "update",
        values: {
          enabled: true,
          exposure: "hidden",
          toolExposure: { read_fixture: "direct", "*": "hidden" },
        },
      });
      const inherited = await list();
      expect(inherited.errors).toEqual([]);
      expect(
        inherited.servers.find(
          (entry: { name: string }) => entry.name === "remote",
        ),
      ).toMatchObject({
        enabled: true,
        exposure: "hidden",
        source: join(agent, "mcp.json"),
        override: project,
        state: "connected",
      });
      expect(initializations).toBe(3);
      expect(authorizations).toEqual([
        "Bearer isolated-mcp-secret",
        "Bearer isolated-mcp-secret",
        "Bearer isolated-mcp-secret",
      ]);
      expect(JSON.parse(await readFile(project, "utf8"))).toEqual({
        mcpServers: {
          remote: {
            enabled: true,
            exposure: "hidden",
            toolExposure: { read_fixture: "direct", "*": "hidden" },
          },
        },
      });
      await edit({ scope: "project", name: "remote", operation: "remove" });
      const restored = await list();
      expect(restored.errors).toEqual([]);
      const remote = restored.servers.find(
        (entry: { name: string }) => entry.name === "remote",
      );
      expect(remote).toMatchObject({
        enabled: true,
        exposure: "direct",
        source: join(agent, "mcp.json"),
        state: "connected",
      });
      expect(remote.override).toBeUndefined();
      expect(initializations).toBe(4);
      expect(authorizations[3]).toBe("Bearer isolated-mcp-secret");
      expect(JSON.parse(await readFile(project, "utf8")).mcpServers).toEqual(
        {},
      );
      expect(await readFile(join(agent, "mcp.json"), "utf8")).toBe(userBefore);
      expect((await command("/mcp")).notifications).toBe(before.notifications);
    }
  } finally {
    await rpc.stop();
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
