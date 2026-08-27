import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTANCE_STATE_VERSION,
  consumeStopRequest,
  inspectInstance,
  instanceUrl,
  portAvailable,
  processStartIdentity,
  removeInstanceState,
  writeInstanceState,
  type InstanceState,
} from "../../server/instance-state.mjs";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inspire-instance-"));
  temporaryDirectories.push(directory);
  return join(directory, "instance.json");
}

function state(port = 4587): InstanceState {
  return {
    schemaVersion: INSTANCE_STATE_VERSION,
    pid: process.pid,
    root: process.cwd(),
    host: "127.0.0.1",
    port,
    token: "test-token-with-sufficient-entropy",
    startedAt: new Date().toISOString(),
    processStartTime: "test-process-start",
    mock: false,
  };
}

describe("Inspire instance state", () => {
  it("writes private atomic state and removes only the owning pid", async () => {
    const path = await temporaryStatePath();
    const value = state();
    await writeInstanceState(path, value);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(value);
    expect(instanceUrl({ ...value, token: "custom/token?" })).toContain(
      "token=custom%2Ftoken%3F",
    );
    expect(instanceUrl({ ...value, token: "local-token" })).toContain(
      "token=local-token",
    );
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    await removeInstanceState(path, value.pid + 1);
    await expect(stat(path)).resolves.toBeDefined();
    await removeInstanceState(path, value.pid);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });

    const requestPath = `${path}.stop-request`;
    await writeInstanceState(path, value);
    await writeFile(requestPath, "stop\n", { mode: 0o600 });
    await expect(consumeStopRequest(requestPath)).resolves.toBe(true);
    await expect(consumeStopRequest(requestPath)).resolves.toBe(false);
  });

  it("recognizes only a verified process with a healthy authenticated host", async () => {
    const path = await temporaryStatePath();
    const server = createServer((request, response) => {
      if (
        request.headers.authorization !==
        "Bearer test-token-with-sufficient-entropy"
      ) {
        response.writeHead(401).end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ appName: "inspire", mock: false }));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a TCP test server");
    const value = state(address.port);
    value.processStartTime = await processStartIdentity(process.pid);
    await writeInstanceState(path, value);
    const processMarker = process.argv[0] as string;

    await expect(
      inspectInstance(
        path,
        { root: value.root, host: value.host, port: value.port, mock: false },
        { processMarker },
      ),
    ).resolves.toMatchObject({ kind: "healthy", state: value });
    await expect(
      inspectInstance(
        path,
        { root: value.root, host: value.host, port: value.port, mock: true },
        { processMarker },
      ),
    ).resolves.toMatchObject({ kind: "mode-conflict" });

    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
    await expect(
      inspectInstance(
        path,
        { root: value.root, host: value.host, port: value.port },
        { processMarker, healthTimeoutMs: 50 },
      ),
    ).resolves.toMatchObject({ kind: "unavailable" });

    value.processStartTime = `${value.processStartTime}-reused`;
    await writeInstanceState(path, value);
    await expect(
      inspectInstance(
        path,
        { root: value.root, host: value.host, port: value.port },
        { processMarker },
      ),
    ).resolves.toEqual({ kind: "stale" });
  });

  it("reports port ownership without disturbing the listener", async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a TCP test server");

    await expect(portAvailable("127.0.0.1", address.port)).resolves.toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
    await expect(portAvailable("127.0.0.1", address.port)).resolves.toBe(true);
  });
});
