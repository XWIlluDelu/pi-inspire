import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
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

it("Pi applies saved project policy only to new loads in a trusted workspace", async () => {
  const workspace = await nativePiWorkspace("inspire-mcp-native-", {
    defaultProjectTrust: "never",
  });
  const { root, agent, cwd } = workspace;
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
  async function loadedStatus() {
    events.length = 0;
    await rpc.request({ type: "prompt", message: "/mcp" });
    return events
      .filter(
        (event) =>
          event.type === "extension_ui_request" && event.method === "notify",
      )
      .map((event) => event.message)
      .join("\n");
  }
  async function savedStatus() {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [piInstallation.cliPath, "mcp", "list", "--json"],
      { cwd, env: workspace.env, timeout: 15_000 },
    );
    const result = JSON.parse(stdout);
    expect(result.errors).toEqual([]);
    return result.servers.find(
      (server: { name: string }) => server.name === "remote",
    );
  }
  try {
    await mkdir(join(cwd, ".pi"));
    const auth = "Bearer isolated-mcp-secret";
    await edit({
      scope: "user",
      name: "remote",
      operation: "add",
      values: { url, headers: { Authorization: auth } },
    });
    await edit({
      scope: "project",
      name: "remote",
      operation: "add",
      values: { enabled: false },
    });
    await rpc.start();
    expect(await loadedStatus()).toMatch(/^remote: connected\b/mu);
    expect(authorizations).toEqual([auth]);

    new ProjectTrustStore(agent).set(cwd, true);
    const source = join(agent, "mcp.json");
    const override = join(cwd, ".pi/mcp.json");
    expect(await savedStatus()).toMatchObject({
      enabled: false,
      source,
      override,
      state: "disabled",
    });
    expect(await loadedStatus()).toMatch(/^remote: connected\b/mu);
    expect(authorizations).toEqual([auth]);

    await edit({
      scope: "project",
      name: "remote",
      operation: "update",
      values: { enabled: true, exposure: "hidden" },
    });
    expect(await savedStatus()).toMatchObject({
      enabled: true,
      exposure: "hidden",
      state: "connected",
    });
    expect(authorizations).toEqual([auth, auth]);
  } finally {
    await rpc.stop();
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
