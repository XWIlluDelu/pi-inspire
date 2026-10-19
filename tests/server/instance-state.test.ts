import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstanceHttpControl } from "../../server/instance-control.mjs";
import {
  consumeStopRequest,
  INSTANCE_STATE_VERSION,
  type InstanceState,
  inspectInstance,
  instanceUrl,
  portAvailable,
  processStartIdentity,
  removeInstanceState,
  stopManagedInstance,
  writeInstanceState,
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
  it("cancels a dedicated foreign-PID birth query without changing default lookup", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      { stdio: "ignore", windowsHide: true },
    );
    try {
      await once(child, "spawn");
      const controller = new AbortController();
      controller.abort();
      await expect(
        processStartIdentity(child.pid!, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await processStartIdentity(child.pid!)).toEqual(
        expect.any(String),
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  });

  it("does not cancel or poison the shared immutable self-birth cache", async () => {
    const birth = await processStartIdentity(process.pid);
    const controller = new AbortController();
    controller.abort();
    expect(await processStartIdentity(process.pid, controller.signal)).toBe(
      birth,
    );
    expect(await processStartIdentity(process.pid)).toBe(birth);
  });

  it("writes private atomic state and removes only the exact owner", async () => {
    const path = await temporaryStatePath();
    const value = state();
    await writeInstanceState(path, value);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(value);
    expect(instanceUrl({ ...value, token: "custom/token?" })).toBe(
      "http://127.0.0.1:4587/",
    );
    expect(instanceUrl({ ...value, token: "local-token", host: "::1" })).toBe(
      "http://[::1]:4587/",
    );
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    await removeInstanceState(path, { ...value, token: "different-owner" });
    await expect(stat(path)).resolves.toBeDefined();
    await removeInstanceState(path, value);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });

    const requestPath = `${path}.stop-request`;
    await writeInstanceState(path, value);
    await writeFile(requestPath, "stop\n", { mode: 0o600 });
    await expect(consumeStopRequest(requestPath)).resolves.toBe(true);
    await expect(consumeStopRequest(requestPath)).resolves.toBe(false);
  });

  it("fails closed on malformed state instead of treating it as absent", async () => {
    const path = await temporaryStatePath();
    await writeFile(path, "not-json\n", { mode: 0o600 });

    await expect(
      inspectInstance(path, {
        root: process.cwd(),
        host: "127.0.0.1",
        port: 4587,
      }),
    ).rejects.toThrow();
  });

  it("does not remove a publication owned by another instance", async () => {
    const path = await temporaryStatePath();
    const value = state();
    await writeInstanceState(path, value);

    await expect(
      stopManagedInstance(path, {
        root: `${value.root}-different`,
        host: value.host,
        port: value.port,
      }),
    ).resolves.toEqual({ kind: "stale" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(value);
  });

  it("recognizes only a verified process with a healthy authenticated host", async () => {
    const path = await temporaryStatePath();
    const control = new InstanceHttpControl();
    let owner: InstanceState;
    const server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBeUndefined();
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const grant = control.accept(
        owner,
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (!grant) {
        response.writeHead(401).end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          control.reply(grant, { appName: "inspire", mock: false }),
        ),
      );
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
    value.httpControlVersion = 1;
    owner = { ...value };
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
  }, 45_000);

  it("does not merge distinct case-sensitive roots even under Windows rules", async (context) => {
    const path = await temporaryStatePath();
    const lower = path + "-root";
    const upper = path + "-ROOT";
    await mkdir(lower);
    if (
      await access(upper).then(
        () => true,
        () => false,
      )
    )
      return context.skip();
    await mkdir(upper);
    const owner = {
      ...state(),
      root: upper,
      processStartTime: await processStartIdentity(process.pid),
    };
    await writeInstanceState(path, owner);
    // Use the real case-sensitive filesystem while selecting Windows path
    // rules. Reject before any process query/network call; no OS is emulated.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await expect(
        inspectInstance(path, {
          root: lower,
          host: owner.host,
          port: owner.port,
        }),
      ).resolves.toEqual({ kind: "stale" });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  }, 30_000);

  it("accepts an existing root's case alias only on an actually aliasing volume", async (context) => {
    const path = await temporaryStatePath();
    const lower = path + "-root";
    const upper = path + "-ROOT";
    await mkdir(lower);
    if (
      !(await access(upper).then(
        () => true,
        () => false,
      ))
    )
      return context.skip();
    const owner = {
      ...state(),
      root: lower,
      processStartTime: await processStartIdentity(process.pid),
    };
    await writeInstanceState(path, owner);
    // A live non-Host test process is unavailable, not a mismatched-root stale
    // publication, when the native filesystem confirms that both names alias.
    await expect(
      inspectInstance(
        path,
        {
          root: upper,
          host: owner.host,
          port: owner.port,
        },
        { processMarker: process.argv[0] },
      ),
    ).resolves.toMatchObject({ kind: "unavailable" });
  }, 30_000);

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
