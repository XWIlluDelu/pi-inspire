import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it } from "vitest";
import { stopManagedInstance } from "../../server/instance-state.mjs";
import {
  isolatedProcessOptions,
  signalProcessTree,
} from "../../server/process-tree.mjs";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

const root = resolve(import.meta.dirname, "../..");
const running: Array<{
  child: ChildProcess;
  exit: Promise<number>;
  log: () => string;
  home: string;
  environment: NodeJS.ProcessEnv;
}> = [];
const directories: string[] = [];
const listeners: Server[] = [];
const inheritedToken = "synthetic-inherited-token-not-for-development";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP listener");
  return address.port;
}
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
async function scenario(webPort?: number) {
  const home = await mkdtemp(join(tmpdir(), "inspire-dev-fixture-"));
  directories.push(home);
  const sentinel = join(home, "inherited-instance.json");
  await writeFile(sentinel, "existing instance must remain untouched");
  const backendPort = await freePort();
  const frontendPort = webPort ?? (await freePort());
  const environment = isolatedTestEnvironment(home, {
    INSPIRE_HOST: "127.0.0.1",
    INSPIRE_PORT: String(backendPort),
    INSPIRE_DEV_PORT: String(frontendPort),
    INSPIRE_STATE_PATH: sentinel,
    INSPIRE_TOKEN: inheritedToken,
    INSPIRE_PI_COMMAND: process.env.INSPIRE_PI_COMMAND,
    INSPIRE_MOCK: "1",
    INSPIRE_OPEN: "0",
    INSPIRE_TERMINAL_IN_PROCESS: "1",
    BROWSER: "none",
    CI: "1",
    NPM_CONFIG_CACHE: join(home, "npm-cache"),
  });
  return { home, sentinel, backendPort, frontendPort, environment };
}
function start(
  environment: NodeJS.ProcessEnv,
  home: string,
): (typeof running)[number] {
  const child = spawn(process.execPath, [join(root, "scripts/start-dev.mjs")], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    ...isolatedProcessOptions(),
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output = (output + String(chunk)).slice(-64 * 1024);
  };
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);
  const exit = new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
  const instance = {
    child,
    exit,
    log: () => stripVTControlCharacters(output),
    home,
    environment,
  };
  running.push(instance);
  return instance;
}
async function ready(instance: ReturnType<typeof start>) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const match = /INSΠRE development:\s+(http:\/\/\S+)/u.exec(instance.log());
    if (match) return new URL(match[1]!);
    if (instance.child.exitCode !== null || instance.child.signalCode !== null)
      throw new Error(instance.log() || "Development exited before readiness");
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Development readiness timed out\n${instance.log()}`);
}
async function stop(instance: ReturnType<typeof start>) {
  if (instance.child.exitCode !== null || instance.child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    // Windows child.kill does not deliver a catchable POSIX shutdown signal.
    // Retire the fixture Host through its private control directory before
    // force-closing this owned npm/Vite/watch toolchain.
    for (const entry of await readdir(instance.home)) {
      if (!entry.startsWith("inspire-dev-")) continue;
      const result = await stopManagedInstance(
        join(instance.home, entry, "host.json"),
        {
          root,
          host: "127.0.0.1",
          port: Number(instance.environment.INSPIRE_PORT),
        },
      );
      expect(["stopped", "absent", "stale"]).toContain(result.kind);
    }
    await signalProcessTree(instance.child, "SIGKILL", { isolated: true });
  } else {
    await signalProcessTree(instance.child, "SIGTERM", { isolated: true });
  }
  const timer = setTimeout(() => {
    void signalProcessTree(instance.child, "SIGKILL", { isolated: true });
  }, 15_000);
  try {
    await instance.exit;
  } finally {
    clearTimeout(timer);
  }
}
afterEach(async () => {
  await Promise.all(running.splice(0).map(stop));
  await Promise.all(
    listeners
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("opens only a ready owned dev origin, uses a one-use grant, and leaves inherited credentials/state alone", async () => {
  const fixture = await scenario();
  const instance = start(fixture.environment, fixture.home);
  const url = await ready(instance);
  expect(url.origin).toBe(`http://127.0.0.1:${fixture.frontendPort}`);
  expect(url.search).toBe("");
  expect(url.hash).toMatch(/^#inspire-bootstrap=[A-Za-z0-9_-]{43}$/u);
  expect(instance.log()).not.toContain(inheritedToken);
  expect((await fetch(url)).status).toBe(200);
  const health = await fetch(new URL("/api/health", url), {
    headers: { Authorization: `Bearer ${inheritedToken}` },
  });
  expect(health.status).toBe(401);
  const bootstrap = new URLSearchParams(url.hash.slice(1)).get(
    "inspire-bootstrap",
  );
  const publicKey = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  }).publicKey.export({ format: "jwk" });
  const pair = () =>
    fetch(new URL("/api/auth/pair", url), {
      method: "POST",
      headers: { Origin: url.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ bootstrap, publicKey }),
    });
  const registration = await pair();
  expect(registration.status).toBe(200);
  expect((await registration.json()).certificate).toMatch(
    /^ib1\.certificate\./u,
  );
  expect((await pair()).status).toBe(401);
  expect(await readFile(fixture.sentinel, "utf8")).toBe(
    "existing instance must remain untouched",
  );
  await stop(instance);
  if (process.platform !== "win32") expect(instance.child.exitCode).toBe(0);
}, 45_000);

it("refuses an occupied UI port without opening it or sending a credential", async () => {
  const requests: string[] = [];
  const fake = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.end("unrelated listener");
  });
  listeners.push(fake);
  const fixture = await scenario(await listen(fake));
  const instance = start(fixture.environment, fixture.home);
  expect(await instance.exit).not.toBe(0);
  expect(instance.log()).toContain("already in use");
  expect(instance.log()).not.toContain("INSΠRE development:");
  expect(instance.log()).not.toContain(inheritedToken);
  expect(requests).toEqual([]);
  expect(await readFile(fixture.sentinel, "utf8")).toBe(
    "existing instance must remain untouched",
  );
}, 30_000);

it("does not start against an occupied backend or contact that listener with a reusable credential", async () => {
  const requests: string[] = [];
  const fake = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.end("not Inspire");
  });
  listeners.push(fake);
  const port = await listen(fake);
  const fixture = await scenario();
  const instance = start(
    {
      ...fixture.environment,
      INSPIRE_PORT: String(port),
    },
    fixture.home,
  );
  expect(await instance.exit).not.toBe(0);
  expect(instance.log()).toContain("choose a separate INSPIRE_PORT");
  expect(instance.log()).not.toContain(inheritedToken);
  expect(requests).toEqual([]);
  expect(await readFile(fixture.sentinel, "utf8")).toBe(
    "existing instance must remain untouched",
  );
}, 15_000);
